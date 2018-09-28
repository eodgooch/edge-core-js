// @flow

import { bridgifyObject, onMethod, shareData, watchMethod } from 'yaob'

import type {
  DiskletFolder,
  EdgeAccount,
  EdgeCreateCurrencyWalletOptions,
  EdgeCurrencyToolsMap,
  EdgeCurrencyWallet,
  EdgeDataStore,
  EdgeExchangeCache,
  EdgeExchangeCurrencies,
  EdgeExchangeQuote,
  EdgeExchangeQuoteOptions,
  EdgeExchangeTools,
  EdgeLobby,
  EdgePluginData,
  EdgeSpendInfo,
  EdgeWalletInfo,
  EdgeWalletInfoFull,
  EdgeWalletStates,
  EthererumTransaction
} from '../../edge-core-index.js'
import { signEthereumTransaction } from '../../util/crypto/external.js'
import { base58 } from '../../util/encoding.js'
import { getCurrencyPlugin } from '../currency/currency-selectors.js'
import { makeExchangeCache } from '../exchange/exchange-api.js'
import { makeShapeshiftApi, upgradeQuote } from '../exchange/shapeshift.js'
import {
  createCurrencyWallet,
  findFirstKey,
  listSplittableWalletTypes,
  makeKeysKit,
  makeStorageKeyInfo,
  splitWalletInfo
} from '../login/keys.js'
import { applyKit } from '../login/login.js'
import { cancelOtpReset, disableOtp, enableOtp } from '../login/otp.js'
import {
  changePassword,
  checkPassword,
  deletePassword
} from '../login/password.js'
import { changePin, checkPin2, deletePin } from '../login/pin2.js'
import { changeRecovery, deleteRecovery } from '../login/recovery2.js'
import type { ApiInput } from '../root.js'
import { makeStorageWalletApi } from '../storage/storage-api.js'
import { changeWalletStates } from './account-files.js'
import { ExchangeTools } from './currency-api.js'
import { makeDataStoreApi, makePluginDataApi } from './data-store-api.js'
import { makeLobbyApi } from './lobby-api.js'

/**
 * Client-side Account methods.
 */
class AccountSync {
  +allKeys: Array<EdgeWalletInfoFull>

  getFirstWalletInfo (type: string): ?EdgeWalletInfo {
    const allKeys: any = this.allKeys // WalletInfoFull -> WalletInfo
    return findFirstKey(allKeys, type)
  }

  getWalletInfo (id: string): ?EdgeWalletInfo {
    const allKeys: any = this.allKeys // WalletInfoFull -> WalletInfo
    return allKeys.find(info => info.id === id)
  }

  listWalletIds (): Array<string> {
    return this.allKeys.map(info => info.id)
  }
}
shareData(AccountSync.prototype, 'AccountSync')

/**
 * Creates an unwrapped account API object around an account state object.
 */
export function makeAccountApi (
  ai: ApiInput,
  accountId: string,
  currencyTools: EdgeCurrencyToolsMap
): EdgeAccount {
  const selfState = () => ai.props.state.accounts[accountId]
  const { accountWalletInfo, loginType } = selfState()

  const exchangeTools = {
    shapeshift: new ExchangeTools()
  }
  const exchangeCache = makeExchangeCache(ai)
  const dataStore = makeDataStoreApi(ai, accountId)
  const pluginData = makePluginDataApi(dataStore)
  const storageWalletApi = makeStorageWalletApi(ai, accountWalletInfo)

  const shapeshiftApi = makeShapeshiftApi(ai)

  function lockdown () {
    if (ai.props.state.hideKeys) {
      throw new Error('Not available when `hideKeys` is enabled')
    }
  }

  const out: EdgeAccount = {
    on: onMethod,
    watch: watchMethod,

    // Data store:
    get id (): string {
      return storageWalletApi.id
    },
    get type (): string {
      return storageWalletApi.type
    },
    get keys (): Object {
      lockdown()
      return storageWalletApi.keys
    },
    get folder (): DiskletFolder {
      lockdown()
      return storageWalletApi.folder
    },
    get localFolder (): DiskletFolder {
      lockdown()
      return storageWalletApi.localFolder
    },
    async sync (): Promise<mixed> {
      return storageWalletApi.sync()
    },

    // Basic login information:
    get appId (): string {
      return selfState().login.appId
    },
    get loggedIn (): boolean {
      return selfState() != null
    },
    get loginKey (): string {
      lockdown()
      return base58.stringify(selfState().login.loginKey)
    },
    get recoveryKey (): string | void {
      lockdown()
      const { login } = selfState()
      return login.recovery2Key != null
        ? base58.stringify(login.recovery2Key)
        : void 0
    },
    get username (): string {
      const { loginTree } = selfState()
      if (!loginTree.username) throw new Error('Missing username')
      return loginTree.username
    },

    // Speciality API's:
    get currencyTools (): EdgeCurrencyToolsMap {
      return currencyTools
    },
    get exchangeTools (): { [pluginName: string]: EdgeExchangeTools } {
      return exchangeTools
    },
    get exchangeCache (): EdgeExchangeCache {
      return exchangeCache
    },
    get dataStore (): EdgeDataStore {
      return dataStore
    },
    get pluginData (): EdgePluginData {
      return pluginData
    },

    // What login method was used?
    get edgeLogin (): boolean {
      const { loginTree } = selfState()
      return loginTree.loginKey == null
    },
    keyLogin: loginType === 'keyLogin',
    newAccount: loginType === 'newAccount',
    passwordLogin: loginType === 'passwordLogin',
    pinLogin: loginType === 'pinLogin',
    recoveryLogin: loginType === 'recoveryLogin',

    // Change or create credentials:
    async changePassword (password: string): Promise<mixed> {
      lockdown()
      return changePassword(ai, accountId, password).then(() => {})
    },
    async changePin (opts: {
      pin?: string, // We keep the existing PIN if unspecified
      enableLogin?: boolean // We default to true if unspecified
    }): Promise<string> {
      lockdown()
      const { pin, enableLogin } = opts
      return changePin(ai, accountId, pin, enableLogin).then(() => {
        const { login } = selfState()
        return login.pin2Key ? base58.stringify(login.pin2Key) : ''
      })
    },
    async changeRecovery (
      questions: Array<string>,
      answers: Array<string>
    ): Promise<string> {
      lockdown()
      return changeRecovery(ai, accountId, questions, answers).then(() => {
        const { loginTree } = selfState()
        if (!loginTree.recovery2Key) {
          throw new Error('Missing recoveryKey')
        }
        return base58.stringify(loginTree.recovery2Key)
      })
    },

    // Verify existing credentials:
    async checkPassword (password: string): Promise<boolean> {
      lockdown()
      const { loginTree } = selfState()
      return checkPassword(ai, loginTree, password)
    },
    async checkPin (pin: string): Promise<boolean> {
      lockdown()
      const { login, loginTree } = selfState()

      // Try to check the PIN locally, then fall back on the server:
      return login.pin != null
        ? pin === login.pin
        : checkPin2(ai, loginTree, pin)
    },

    // Remove credentials:
    async deletePassword (): Promise<mixed> {
      lockdown()
      return deletePassword(ai, accountId).then(() => {})
    },
    async deletePin (): Promise<mixed> {
      lockdown()
      return deletePin(ai, accountId).then(() => {})
    },
    async deleteRecovery (): Promise<mixed> {
      lockdown()
      return deleteRecovery(ai, accountId).then(() => {})
    },

    // OTP:
    get otpKey (): string | void {
      lockdown()
      const { login } = selfState()
      return login.otpTimeout != null ? login.otpKey : void 0
    },
    get otpResetDate (): string | void {
      lockdown()
      const { login } = selfState()
      return login.otpResetDate
    },
    async cancelOtpReset (): Promise<mixed> {
      lockdown()
      return cancelOtpReset(ai, accountId).then(() => {})
    },
    async enableOtp (timeout: number = 7 * 24 * 60 * 60): Promise<mixed> {
      lockdown()
      return enableOtp(ai, accountId, timeout).then(() => {})
    },
    async disableOtp (): Promise<mixed> {
      lockdown()
      return disableOtp(ai, accountId).then(() => {})
    },

    // Edge login approval:
    async fetchLobby (lobbyId: string): Promise<EdgeLobby> {
      lockdown()
      return makeLobbyApi(ai, accountId, lobbyId)
    },

    // Login management:
    async logout (): Promise<mixed> {
      ai.props.dispatch({ type: 'LOGOUT', payload: { accountId } })
    },

    // Master wallet list:
    get allKeys (): Array<EdgeWalletInfoFull> {
      return ai.props.state.hideKeys
        ? ai.props.state.accounts[accountId].allWalletInfosClean
        : ai.props.state.accounts[accountId].allWalletInfosFull
    },
    async changeWalletStates (walletStates: EdgeWalletStates): Promise<mixed> {
      return changeWalletStates(ai, accountId, walletStates)
    },
    async createWallet (type: string, keys: any): Promise<string> {
      const { login, loginTree } = selfState()

      if (keys == null) {
        // Use the currency plugin to create the keys:
        const plugin = getCurrencyPlugin(ai.props.output.currency.plugins, type)
        keys = plugin.createPrivateKey(type)
      }

      const walletInfo = makeStorageKeyInfo(ai, type, keys)
      const kit = makeKeysKit(ai, login, walletInfo)
      return applyKit(ai, loginTree, kit).then(() => walletInfo.id)
    },
    getFirstWalletInfo: AccountSync.prototype.getFirstWalletInfo,
    getWalletInfo: AccountSync.prototype.getWalletInfo,
    listWalletIds: AccountSync.prototype.listWalletIds,
    async splitWalletInfo (
      walletId: string,
      newWalletType: string
    ): Promise<string> {
      return splitWalletInfo(ai, accountId, walletId, newWalletType)
    },
    async listSplittableWalletTypes (walletId: string): Promise<Array<string>> {
      return listSplittableWalletTypes(ai, accountId, walletId)
    },

    // Currency wallets:
    get activeWalletIds (): Array<string> {
      return ai.props.state.accounts[accountId].activeWalletIds
    },
    get archivedWalletIds (): Array<string> {
      return ai.props.state.accounts[accountId].archivedWalletIds
    },
    get currencyWallets (): { [walletId: string]: EdgeCurrencyWallet } {
      return ai.props.output.accounts[accountId].currencyWallets
    },
    async createCurrencyWallet (
      type: string,
      opts?: EdgeCreateCurrencyWalletOptions = {}
    ): Promise<EdgeCurrencyWallet> {
      return createCurrencyWallet(ai, accountId, type, opts)
    },

    async signEthereumTransaction (
      walletId: string,
      transaction: EthererumTransaction
    ): Promise<string> {
      console.log('Edge is signing: ', transaction)
      const { allWalletInfosFull } = selfState()
      const walletInfo = allWalletInfosFull.find(info => info.id === walletId)
      if (!walletInfo || !walletInfo.keys || !walletInfo.keys.ethereumKey) {
        throw new Error('Cannot find the requested private key in the account')
      }
      return signEthereumTransaction(walletInfo.keys.ethereumKey, transaction)
    },

    async getExchangeCurrencies (): Promise<EdgeExchangeCurrencies> {
      const shapeshiftTokens = await shapeshiftApi.getAvailableExchangeTokens()
      const out = {}
      for (const cc of shapeshiftTokens) out[cc] = { exchanges: ['shapeshift'] }
      return out
    },
    async getExchangeQuote (
      opts: EdgeExchangeQuoteOptions
    ): Promise<EdgeExchangeQuote> {
      const { fromWallet, nativeAmount, quoteFor } = opts

      // Hit the legacy API:
      const spendInfo: EdgeSpendInfo = {
        currencyCode: opts.fromCurrencyCode,
        quoteFor,
        nativeAmount,
        spendTargets: [
          {
            destWallet: opts.toWallet,
            currencyCode: opts.toCurrencyCode
          }
        ]
      }
      if (quoteFor === 'to') {
        spendInfo.spendTargets[0].nativeAmount = nativeAmount
      }
      const legacyQuote = await fromWallet.getQuote(spendInfo)

      // Convert that to the new format:
      return upgradeQuote(fromWallet, legacyQuote)
    }
  }
  bridgifyObject(out)

  return out
}
