import lnService from 'ln-service'
import assert from 'assert'
import { createHash, randomBytes } from "crypto";
import moment from "moment";
import { FEECAP, FEEMIN, lnd, TIMEOUT_PAYMENT } from "./lndConfig";
import { disposer, getAsyncRedisClient } from "./lock";
import { MainBook } from "./mongodb";
import { sendInvoicePaidNotification } from "./notification";
import { addTransactionLndPayment, addTransactionLndReceipt, addTransactionOnUsPayment } from "./ledger/transaction";
import { IAddInvoiceRequest, IFeeRequest, IPaymentRequest } from "./types";
import { addContact, isInvoiceAlreadyPaidError, LoggedError, timeout } from "./utils";
import { UserWallet } from "./userWallet";
import { InvoiceUser, Transaction, User } from "./schema";
import { createInvoice, getWalletInfo, decodePaymentRequest, cancelHodlInvoice, payViaPaymentDetails, payViaRoutes, getPayment, getInvoice } from "lightning"

import util from 'util'

import bluebird from 'bluebird';
const { using } = bluebird;

export type ITxType = "invoice" | "payment" | "onchain_receipt" | "onchain_payment" | "on_us"
export type payInvoiceResult = "success" | "failed" | "pending" | "already_paid"


// this value is here so that it can get mocked.
// there could probably be a better design
// but mocking on mixin is tricky
export const delay = (currency) => {
  return {
    "BTC": { value: 1, unit: 'days', "additional_delay_value": 1 },
    "USD": { value: 2, unit: 'mins', "additional_delay_value": 1 },
  }[currency]
}

export const LightningMixin = (superclass) => class extends superclass {
  nodePubKey: string | null = null

  constructor(...args) {
    super(...args)
  }

  // FIXME: this should be static
  async getNodePubkey() {
    this.nodePubKey = this.nodePubKey ?? (await getWalletInfo({ lnd })).public_key
    return this.nodePubKey
  }

  async updatePending() {
    await Promise.all([
      this.updatePendingInvoices(),
      this.updatePendingPayments(),
      super.updatePending(),
    ])
  }

  getExpiration = (input) => {    
    // TODO: manage USD shorter time
    const currency = "BTC"

    return input.add(delay(currency).value, delay(currency).unit)
  }

  async addInvoice({ value, memo, selfGenerated }: IAddInvoiceRequest): Promise<string> {
    let request, id

    const expires_at = this.getExpiration(moment()).toDate()

    let input
    try {
      input = {
        lnd,
        tokens: value,
        description: memo,
        expires_at,
      }
      const result = await createInvoice(input)
      request = result.request
      id = result.id
    } catch (err) {
      const error = "impossible to create the invoice"
      this.logger.error({ err, input }, error)
      throw new LoggedError(error)
    }

    try {
      const result = await new InvoiceUser({
        _id: id,
        uid: this.user.id,
        selfGenerated,
      }).save()

      this.logger.info({ result, value, memo, selfGenerated, id, user: this.user }, "a new invoice has been added")
    } catch (err) {
      // FIXME if the mongodb connection has not been instanciated
      // this fails silently
      const error = `error storing invoice to db`
      this.logger.error({ err }, error)
      throw new LoggedError(error)
    }

    return request
  }

  async getLightningFee(params: IFeeRequest): Promise<Number> {

    // TODO:
    // we should also log the fact we have started the query
    // if (await getAsyncRedisClient().get(JSON.stringify(params))) {
    //   return
    // }
    //
    // OR: add a lock

    // TODO: do a balance check, so that we don't probe needlessly if the user doesn't have the 
    // probably make sense to used a cached balance here. 

    // TODO: if this is a node we are connected with, we may not even need a probe/round trip to redis
    // we could handle this from the front end directly.

    const { mtokens, max_fee, destination, id, routeHint, messages, cltv_delta, features, payment } = 
      await this.validate(params, this.logger)

    const lightningLogger = this.logger.child({ 
      topic: "fee_estimation",
      protocol: "lightning",
      params, 
      decoded: { mtokens, max_fee, destination, id, routeHint, messages, cltv_delta, features, payment }
    })

    const key = JSON.stringify({ id, mtokens })

    const cacheProbe = await getAsyncRedisClient().get(key)
    if (cacheProbe) {
      lightningLogger.info("route result in cache")
      return JSON.parse(cacheProbe).fee
    }


    // safety check
    // this should not happen as this check is done within RN
    if (destination === await this.getNodePubkey()) {
      lightningLogger.warn("probe for self")
      return 0
    }

    let route

    try {
      ({ route } = await lnService.probeForRoute({
        lnd, 
        destination, 
        mtokens, 
        routes: routeHint,
        cltv_delta,
        features,
        max_fee,
        messages,
        payment,
        total_mtokens: payment ? mtokens : undefined,
      }));
    } catch (err) {
      const error = "error getting route / probing for route"
      lightningLogger.error({ err, max_fee, probingSuccess: false, success: false }, error)
      throw new LoggedError(error)
    }

    if (!route) {
      // TODO: check if the error is irrecovable or not.

      const error = "there is no potential route for payment"
      lightningLogger.warn({ probingSuccess: false, success: false }, error)
      throw new LoggedError(error)
    }

    const value = JSON.stringify(route)
    await getAsyncRedisClient().set(key, value, 'EX', 60 * 5); // expires after 5 minutes

    lightningLogger.info({ redis: { key, value }, probingSuccess: true, success: true }, "succesfully found a route")
    return route.fee
  }

  // FIXME this should be static
  async validate(params: IFeeRequest, lightningLogger) {
  
    const keySendPreimageType = '5482373484';
    const preimageByteLength = 32;

    let pushPayment = false
    let tokens
    let expires_at
    let features
    let cltv_delta
    let payment
    let destination, id, description
    let routeHint 
    let messages

    if (params.invoice) {
      // TODO: replace this with invoices/bolt11/parsePaymentRequest function?
      // TODO: use msat instead of sats for the db?

      try {
        ({ id, safe_tokens: tokens, destination, description, routes: routeHint, payment, cltv_delta, expires_at, features } = await decodePaymentRequest({ lnd, request: params.invoice }))
      } catch (err) {
        const error = `Error decoding the invoice`
        lightningLogger.error({ params, success: false, error }, error)
        throw new LoggedError(error)
      }

      // TODO: if expired_at expired, thrown an error

      if (!!params.amount && tokens !== 0) {
        const error = `Invoice contains non-zero amount, but amount was also passed separately`
        lightningLogger.error({ tokens, params, success: false, error }, error)
        throw new LoggedError(error)
      }

    } else {
      if (!params.destination) {
        const error = 'Pay requires either invoice or destination to be specified'
        lightningLogger.error({ invoice: params.invoice, destination, success: false, error }, error)
        throw new LoggedError(error)
      }

      pushPayment = true
      destination = params.destination

      const preimage = randomBytes(preimageByteLength);
      id = createHash('sha256').update(preimage).digest().toString('hex');
      const secret = preimage.toString('hex');
      messages = [{ type: keySendPreimageType, value: secret }]

      // TODO: should it be id or secret?
      // check from keysend invoices generated by lnd
      // payment = payment ?? secret

    }

    if (!params.amount && tokens === 0) {
      const error = 'Invoice is a zero-amount invoice, or pushPayment is being used, but no amount was passed separately'
      lightningLogger.error({ tokens, params, success: false, error }, error)
      throw new LoggedError(error)
    }

    tokens = !!tokens ? tokens : params.amount

    const max_fee = Math.floor(Math.max(FEECAP * tokens, FEEMIN))

    return {
      // FIXME String: https://github.com/alexbosworth/lightning/issues/24
      tokens, mtokens: String(tokens * 1000), destination, pushPayment, id, routeHint, messages, max_fee,
      memoInvoice: description, payment, cltv_delta, expires_at, features,
    }
  }

  async pay(params: IPaymentRequest): Promise<payInvoiceResult | Error> {
    let lightningLogger = this.logger.child({ topic: "payment", protocol: "lightning", transactionType: "payment" })

    const { tokens, mtokens, destination, pushPayment, id, routeHint, messages, memoInvoice, payment, cltv_delta, features, max_fee } = await this.validate(params, lightningLogger)
    const { memo: memoPayer, username: input_username } = params

    // not including message because it contains the preimage and we don't want to log this
    lightningLogger = lightningLogger.child({ decoded: { tokens, destination, pushPayment, id, routeHint, memoInvoice, memoPayer, payment, cltv_delta, features }, params })

    let fee
    let route
    let paymentPromise
    let feeKnownInAdvance


    // TODO: this should be inside the lock.
    // but getBalance is currently also getting the lock. 
    // --> need a re-entrant mutex or another architecture to have balance within the lock
    const balance = await this.getBalances()

    return await using(disposer(this.user._id), async (lock) => {
      // On us transaction
      if (destination === await this.getNodePubkey()) {
        const lightningLoggerOnUs = lightningLogger.child({ onUs: true, fee: 0 })

        let payeeUser

        if (pushPayment) {
          // pay through username
          
          if (!input_username) {
            const error = 'a username is required for push payment to the ***REMOVED*** wallet'
            lightningLoggerOnUs.warn({ success: false, error }, error)
            throw new LoggedError(error)
          }
          payeeUser = await User.findByUsername({ username: input_username })

        } else {
          // standard path, user scan another lightning wallet of bitcoin beach invoice

          const payeeInvoice = await InvoiceUser.findOne({ _id: id })
          if (!payeeInvoice) {
            const error = 'User tried to pay invoice from ***REMOVED*** wallet, but it was already paid or does not exist'
            lightningLoggerOnUs.error({ success: false, error }, error)
            throw new LoggedError(error)
          }

          payeeUser = await User.findOne({ _id: payeeInvoice.uid })
        }

        if (!payeeUser) {
          const error = `this user doesn't exist`
          lightningLoggerOnUs.warn({ success: false, error }, error)
          throw new LoggedError(error)
        }

        if (String(payeeUser._id) === String(this.user._id)) {
          const error = 'User tried to pay himself'
          lightningLoggerOnUs.error({ success: false, error }, error)
          throw new LoggedError(error)
        }

        const sats = tokens
        const metadata = { hash: id, type: "on_us", pending: false, ...UserWallet.getCurrencyEquivalent({ sats, fee: 0 }) }

        // TODO: manage when paid fully in USD directly from USD balance to avoid conversion issue
        if (balance.total_in_BTC < sats) {
          const error = `balance is too low`
          lightningLoggerOnUs.warn({ balance, sats, success: false, error }, error)
          throw new LoggedError(error)
        }

        await addTransactionOnUsPayment({
          description: memoInvoice,
          sats,
          metadata,
          payerUser: this.user,
          payeeUser,
          memoPayer
        })

        await sendInvoicePaidNotification({ amount: sats, user: payeeUser, hash: id, logger: this.logger })

        if (!pushPayment) {
          const resultDeletion = await InvoiceUser.deleteOne({ _id: id })
          this.logger.info({ id, user: this.user, resultDeletion }, "invoice has been deleted from InvoiceUser following on_us transaction")

          await cancelHodlInvoice({ lnd, id })
          this.logger.info({ id, user: this.user }, "canceling invoice on lnd")
        }

        // adding contact for the payer
        if (!!payeeUser.username) {
          await addContact({uid: this.user._id, username: payeeUser.username})
        }

        // adding contact for the payee
        if (!!this.user.username) {
          await addContact({uid: payeeUser._id, username: this.user.username})
        }

        lightningLoggerOnUs.info({ pushPayment, success: true, isReward: params.isReward ?? false, ...metadata }, "lightning payment success")

        return "success"
      }

      // "normal" transaction: paying another lightning node

      // TODO: manage push payment for other node as well
      if (pushPayment) {
        const error = "no push payment to other wallet (yet)"
        lightningLogger.error({ success: false }, error)
        throw new LoggedError(error)
      }

      // TODO: fine tune those values:
      // const probe_timeout_ms
      // const path_timeout_ms

      // TODO: push payment for other node as well
      lightningLogger = lightningLogger.child({ onUs: false, max_fee })

      const key = JSON.stringify({ id, mtokens })
      route = JSON.parse(await getAsyncRedisClient().get(key))
      this.logger.info({ route }, "route from redis")

      if (!!route) {
        lightningLogger = lightningLogger.child({ routing: "payViaRoutes", route })
        fee = route.safe_fee
        feeKnownInAdvance = true
      } else {
        lightningLogger = lightningLogger.child({ routing: "payViaPaymentDetails" })
        fee = max_fee
        feeKnownInAdvance = false
      }

      // we are confident enough that there is a possible payment route. let's move forward
      // TODO quote for fees, and also USD for USD users

      let entry

      {
        
        const sats = tokens + fee

        const metadata = {
          hash: id, type: "payment", pending: true,  
          feeKnownInAdvance, ...UserWallet.getCurrencyEquivalent({ sats, fee })
        }

        lightningLogger = lightningLogger.child({ route, balance, ...metadata })

        // TODO usd management for balance

        if (balance.total_in_BTC < sats) {
          const error = `balance is too low`
          lightningLogger.warn({ success: false, error }, error)
          throw new LoggedError(error)
        }

        // reduce balance from customer first

        entry = await addTransactionLndPayment({
          description: memoInvoice,
          payerUser: this.user,
          sats,
          metadata,
        })


        if (pushPayment) {
          route.messages = messages
        }


        // there is 3 scenarios for a payment.
        // 1/ payment succeed (function return before TIMEOUT_PAYMENT) and:
        // 1A/ fees are known in advance
        // 1B/ fees are not kwown in advance --> need to refund for the difference in fees?
        //   for now we keep the change

        // 2/ the payment fails. we are reverting it. this including voiding prior transaction
        // 3/ payment is still pending after TIMEOUT_PAYMENT.
        // we are timing out the request for UX purpose, so that the client can show the payment is pending
        // even if the payment is still ongoing from lnd.
        // to clean pending payments, another cron-job loop will run in the background.

        try {

          // Fixme: seems to be leaking if it timeout.
          if (route) {
            paymentPromise = payViaRoutes({ lnd, routes: [route], id })

          } else {

            // incoming_peer?
            // max_paths for MPP
            // max_timeout_height ??
            paymentPromise = payViaPaymentDetails({
              lnd,
              id,
              cltv_delta,
              destination,
              features,
              max_fee,
              messages,
              mtokens,
              payment,
              routes: routeHint,
            })
          }

          await Promise.race([paymentPromise, timeout(TIMEOUT_PAYMENT, 'Timeout')])
          // FIXME
          // return this.payDetail({
          //     pubkey: details.destination,
          //     hash: details.id,
          //     amount: details.tokens,
          //     routes: details.routes
          // })

        } catch (err) {

          if (err.message === "Timeout") {
            lightningLogger.warn({ ...metadata, pending: true }, 'timeout payment')

            return "pending"
            // pending in-flight payment are being handled either by a cron job 
            // or payment update when the user query his balance
          }

          try {
            // FIXME: this query may not make sense 
            // where multiple payment have the same hash
            // ie: when a payment is being retried
            await Transaction.updateMany({ hash: id }, { pending: false, error: err[1] })
            await MainBook.void(entry.journal._id, err[1])
            lightningLogger.warn({ success: false, err, ...metadata, entry }, `payment error`)

          } catch (err_fatal) {
            const error = `ERROR CANCELING PAYMENT ENTRY`
            lightningLogger.fatal({ err, err_fatal, entry }, error)
            throw new LoggedError(error)
          }

          if (isInvoiceAlreadyPaidError(err)) {
            lightningLogger.warn({ ...metadata, pending: false }, 'invoice already paid')
            return "already_paid"
          }

          throw new LoggedError(`Error paying invoice: ${util.inspect({ err }, false, Infinity)}`)
        }

        // success
        await Transaction.updateMany({ hash: id }, { pending: false })
        const paymentResult = await paymentPromise

        if (!feeKnownInAdvance) {
          await this.recordFeeDifference({ paymentResult, max_fee, id, related_journal: entry.journal._id })
        }

        lightningLogger.info({ success: true, paymentResult, ...metadata }, `payment success`)
      }

      return "success"

    })
  }

  // this method is used when the probing failed
  //
  // there are times when it's not possible to know in advance the fees
  // this could be because the receiving doesn't respond to the fake payment hash
  // or because there is no liquidity for a one-sum payment, but there could 
  // be liquidity if the payment was using MPP
  //
  // in this scenario, we have withdrawal a percent of fee (`max_fee`)
  // and once we know precisely how much the payment was we reimburse the difference
  async recordFeeDifference({ paymentResult, max_fee, id, related_journal }) {
    const feeDifference = max_fee - paymentResult.safe_fee

    assert(feeDifference >= 0)
    assert(feeDifference <= max_fee)

    this.logger.info({ paymentResult, feeDifference, max_fee, actualFee: paymentResult.safe_fee, id }, "logging a fee difference")

    const {usd} = UserWallet.getCurrencyEquivalent({sats: feeDifference})
    const metadata = { currency: "BTC", hash: id, related_journal, type: "fee_reimbursement", usd, pending: false }

    // todo: add a reference to the journal entry of the main tx

    await addTransactionLndReceipt({
     description: "fee reimbursement",
     payeeUser: this.user,
     metadata,
     sats: feeDifference
    })
    //
  }

  // TODO manage the error case properly. right now there is a mix of string being return
  // or error being thrown. Not sure how this is handled by GraphQL

  async updatePendingPayments() {

    const query = { accounts: this.user.accountPath, type: "payment", pending: true }
    const count = await Transaction.countDocuments(query)

    if (count === 0) {
      return
    }

    // we only lock the account if there is some pending payment transaction, which would typically be unlikely
    // we're doing the the Transaction.find after the lock to make sure there is no race condition
    // note: there might be another design that doesn't requiere a lock at the uid level but only at the hash level,
    // but will need to dig more into the cursor aspect of mongodb to see if there is a concurrency-safe way to do it.
    return await using(disposer(this.user._id), async (lock) => {

      const payments = await Transaction.find(query)

      for (const payment of payments) {

        let result
        try {
          result = await getPayment({ lnd, id: payment.hash })
        } catch (err) {
          const error = 'issue fetching payment'
          this.logger.error({ err, payment }, error)
          throw new LoggedError(error)
        }

        if (result.is_confirmed || result.is_failed) {
          payment.pending = false
          await payment.save()
        }

        const lightningLogger = this.logger.child({ topic: "payment", protocol: "lightning", transactionType: "payment", onUs: false })

        if (result.is_confirmed) {
          lightningLogger.info({ success: true, id: payment.hash, payment }, 'payment has been confirmed')

          if (!payment.feeKnownInAdvance) {
            await this.recordFeeDifference({ paymentResult: result.payment, max_fee: payment.fee, id: payment.hash, related_journal: payment._journal })
          }

        }

        if (result.is_failed) {
          try {
            await MainBook.void(payment._journal, "Payment canceled") // JSON.stringify(result.failed
            lightningLogger.info({ success: false, id: payment.hash, payment, result }, 'payment has been canceled')
          } catch (err) {
            const error = `error canceling payment entry`
            this.logger.fatal({ err, payment, result }, error)
            throw new LoggedError(error)
          }
        }
      }

    })
  }

  async updatePendingInvoice({ hash, expired = false }) {
    let invoice

    try {
      // FIXME we should only be able to look at User invoice, 
      // but might not be a strong problem anyway
      // at least return same error if invoice not from user
      // or invoice doesn't exist. to preserve privacy and prevent DDOS attack.
      invoice = await getInvoice({ lnd, id: hash })

      // TODO: we should not log/keep secret in the logs
      this.logger.debug({ invoice, user: this.user }, "got invoice status")
    } catch (err) {
      const error = `issue fetching invoice`
      this.logger.error({ err, invoice }, error)
      throw new LoggedError(error)
    }

    // invoice that are on_us will be cancelled but not confirmed
    // so we need a branch to return true in case the payment 
    // has been managed off lnd.
    if (invoice.is_canceled) {

      // check what happen if we go to this loop twice?
      const resultDeletion = await InvoiceUser.deleteOne({ _id: hash, uid: this.user._id })
      this.logger.info({ hash, user: this.user, resultDeletion }, "succesfully deleted cancelled invoice")

      // TODO: proper testing
      const result = await Transaction.findOne({ hash, type: "on_us", pending: false })
      return !!result

    } else if (invoice.is_confirmed) {

      try {

        return await using(disposer(hash), async (lock) => {

          const invoiceUser = await InvoiceUser.findOne({ _id: hash, uid: this.user._id })

          if (!invoiceUser) {
            this.logger.info({ hash, user: this.user._id }, "invoice has already been processed")
            return true
          }

          // TODO: use a transaction here
          // const session = await InvoiceUser.startSession()
          // session.withTransaction(

          // OR: use a an unique index account / hash / voided
          // may still not avoid issue from discrenpency between hash and the books

          const resultDeletion = await InvoiceUser.deleteOne({ _id: hash, uid: this.user._id })
          this.logger.info({ hash, user: this.user._id, resultDeletion }, "invoice has been deleted")

          const sats = invoice.received

          const metadata = { hash, type: "invoice", pending: false, ...UserWallet.getCurrencyEquivalent({ sats, fee: 0 }) }

          await addTransactionLndReceipt({
            description: invoice.description,
            payeeUser: this.user,
            metadata,
            sats
          })

          this.logger.info({ topic: "payment", protocol: "lightning", transactionType: "receipt", onUs: false, success: true, metadata })

          return true
        })

      } catch (err) {
        const error = `issue updating invoice`
        this.logger.error({ err, invoice }, error)
        throw new LoggedError(error)
      }
    } else if (expired) {

      // maybe not needed after old invoice has been deleted?

      try {
        await cancelHodlInvoice({ lnd, id: hash })
        this.logger.info({ id: hash, user: this.user._id }, "canceling invoice")

      } catch (err) {
        const error = "error deleting invoice"
        this.logger.error({ err, error, hash, user: this.user._id }, error)
      }

      const resultDeletion = await InvoiceUser.deleteOne({ _id: hash, user: this.user._id })
      this.logger.info({ hash, user: this.user._id, resultDeletion }, "succesfully deleted expired invoice")

    }

    return false
  }

  // should be run regularly with a cronjob
  // TODO: move to an "admin/ops" wallet
  async updatePendingInvoices() {

    // TODO
    const currency = "BTC"

    // TODO: hydrates invoices from User?
    const invoices = await InvoiceUser.find({ uid: this.user._id })

    for (const invoice of invoices) {
      const { _id, timestamp } = invoice

      // FIXME
      // adding a time-buffer on the expiration before we delete the invoice 
      // because it seems lnd still can accept invoice even if they have expired
      // see more: https://github.com/lightningnetwork/lnd/pull/3694
      const expired = moment() > this.getExpiration(moment(timestamp)
        .add(delay(currency).additional_delay_value, "hours")
      )
      await this.updatePendingInvoice({ hash: _id, expired })
    }
  }

}
