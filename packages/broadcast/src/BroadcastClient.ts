import { type Client, type Conversation } from "@xmtp/xmtp-js"

import { BroadcastConstructorParams, BroadcastOptions } from "./types"

const GENERAL_RATE_LIMIT = 10000

export class BroadcastClient<ContentTypes = unknown> {
  client: Client<ContentTypes>
  addresses: string[]
  cachedCanMessageAddresses: Set<string>
  rateLimitAmount: number
  rateLimitTime: number
  batches: string[][] = []
  errorBatch: string[] = []
  conversationMapping: Map<string, Conversation> = new Map()

  // Callbacks
  /**
   * Called when a batch of addresses is about to be sent
   */
  onBatchStart?: (addresses: string[]) => void
  /**
   * Called when a batch of addresses has been sent/failed
   */
  onBatchComplete?: (addresses: string[]) => void
  /**
   * Called when all addresses have been sent/failed
   */
  onBroadcastComplete?: () => void
  /**
   * Called when an address can't be messaged
   */
  onCantMessageAddress?: (address: string) => void
  /**
   * Called when a message is about to be sent
   */
  onMessageSending?: (address: string) => void
  /**
   * Called when a message fails to send
   */
  onMessageFailed?: (address: string) => void
  /**
   * Called when a message is successfully sent
   */
  onMessageSent?: (address: string) => void
  /**
   * Called when the list of addresses that can be messaged is updated, this is useful for caching
   */
  onCanMessageAddressesUpdate?: (addresses: string[]) => void
  /**
   * Called when a delay is about to happen
   */
  onDelay?: (ms: number) => void

  constructor({
    client,
    addresses,
    cachedCanMessageAddresses,
    rateLimitAmount = 1000,
    rateLimitTime = 1000 * 60 * 5,
    onBatchStart,
    onBatchComplete,
    onBroadcastComplete,
    onCantMessageAddress,
    onMessageSending,
    onMessageFailed,
    onMessageSent,
    onCanMessageAddressesUpdate,
    onDelay,
  }: BroadcastConstructorParams<ContentTypes>) {
    this.client = client
    this.addresses = addresses
    this.cachedCanMessageAddresses = new Set(cachedCanMessageAddresses)
    this.rateLimitAmount = rateLimitAmount
    this.rateLimitTime = rateLimitTime
    this.onBatchStart = onBatchStart
    this.onBatchComplete = onBatchComplete
    this.onBroadcastComplete = onBroadcastComplete
    this.onCantMessageAddress = onCantMessageAddress
    this.onMessageSending = onMessageSending
    this.onMessageFailed = onMessageFailed
    this.onMessageSent = onMessageSent
    this.onCanMessageAddressesUpdate = onCanMessageAddressesUpdate
    this.onDelay = onDelay
  }

  public broadcast = async (
    messages: Exclude<ContentTypes, undefined>[],
    options: BroadcastOptions,
  ) => {
    const skipInitialDelay = options.skipInitialDelay ?? false
    const client = this.client
    const conversations = await client.conversations.list()
    for (const conversation of conversations) {
      this.conversationMapping.set(conversation.peerAddress, conversation)
    }
    if (
      !skipInitialDelay &&
      conversations.length / 2 > GENERAL_RATE_LIMIT - this.rateLimitAmount
    ) {
      await this.delay()
    }

    this.batches = this.getBatches(messages.length)
    for (let batchIndex = 0; batchIndex < this.batches.length; batchIndex++) {
      await this.handleBatch({
        addresses: this.batches[batchIndex],
        messages,
      })
      if (batchIndex !== this.batches.length - 1) {
        await this.delay()
      } else {
        await this.sendErrorBatch(messages)
      }
    }
    this.onBroadcastComplete?.()
  }

  private handleBatch = async ({
    addresses,
    messages,
  }: {
    addresses: string[]
    messages: ContentTypes[]
  }) => {
    this.onBatchStart?.(addresses)
    await this.canMessageAddresses(addresses, this.onCanMessageAddressesUpdate)
    for (const address of addresses) {
      if (!this.cachedCanMessageAddresses.has(address)) {
        this.onCantMessageAddress?.(address)
        continue
      }
      try {
        let conversation = this.conversationMapping.get(address)
        if (!conversation) {
          conversation =
            await this.client.conversations.newConversation(address)
          this.conversationMapping.set(address, conversation)
        }

        for (const message of messages) {
          this.onMessageSending?.(address)
          await conversation.send(message)
        }
        this.onMessageSent?.(address)
        // Clear up some memory after we are done with the conversation
        this.cachedCanMessageAddresses.delete(address)
        this.conversationMapping.delete(address)
      } catch (err) {
        console.error(err)
        this.onMessageFailed?.(address)
        this.errorBatch.push(address)
        await this.delay()
      }
    }
    this.onBatchComplete?.(addresses)
  }

  private sendErrorBatch = async (
    messages: Exclude<ContentTypes, undefined>[],
  ) => {
    if (this.errorBatch.length === 0) {
      return
    }
    const finalErrors: string[] = []
    for (const address of this.errorBatch) {
      try {
        const conversation =
          await this.client.conversations.newConversation(address)
        for (const message of messages) {
          await conversation.send(message)
        }
        this.onMessageSent?.(address)
      } catch (err) {
        this.onMessageFailed?.(address)
        await this.delay()
      }
    }
    this.errorBatch = finalErrors
  }

  private canMessageAddresses = async (
    addresses: string[],
    onCanMessageAddressesUpdate?: (newAddresses: string[]) => void,
  ) => {
    const unknownStateAddresses: string[] = []
    for (let i = 0; i < addresses.length; i++) {
      if (!this.cachedCanMessageAddresses.has(addresses[i])) {
        unknownStateAddresses.push(addresses[i])
      }
    }
    const canMessageAddresses = await this.client.canMessage(
      unknownStateAddresses,
    )
    const newCanMessageAddresses: string[] = []
    for (let i = 0; i < addresses.length; i++) {
      if (canMessageAddresses[i]) {
        newCanMessageAddresses.push(addresses[i])
        this.cachedCanMessageAddresses.add(addresses[i])
      }
    }
    onCanMessageAddressesUpdate?.(newCanMessageAddresses)
  }

  private delay = async () => {
    const ms = this.rateLimitTime
    this.onDelay?.(ms)
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  private getBatches = (messageCount: number): string[][] => {
    let batch: string[] = []
    const batches: string[][] = []
    let batchCount = 0
    for (const address of this.addresses) {
      let addressWeight = 0
      // No matter what we will want to send a message so this is the number of messages being sent
      addressWeight += messageCount
      if (!this.conversationMapping.has(address)) {
        // this conversation will likely need to be created
        // so we count it as 3 Posts
        // 1. create user invite
        // 2. create peer invite
        // 3. allow contact
        addressWeight += 3
      } else {
        addressWeight += 1
      }
      const newBatchCount = batchCount + addressWeight
      if (newBatchCount === this.rateLimitAmount) {
        batch.push(address)
        batches.push(batch)
        batch = []
        batchCount = 0
      } else if (newBatchCount > this.rateLimitAmount) {
        batches.push(batch)
        batch = []
        batch.push(address)
        batchCount = addressWeight
      } else {
        batch.push(address)
        batchCount = newBatchCount
      }
    }
    if (batch.length > 0) {
      batches.push(batch)
    }
    return batches
  }

  setAddresses(addresses: string[]) {
    this.addresses = addresses
  }

  setRateLimitAmount(amount: number) {
    this.rateLimitAmount = amount
  }

  setRateLimitTime(time: number) {
    this.rateLimitTime = time
  }

  setOnBatchStart(callback: (addresses: string[]) => void) {
    this.onBatchStart = callback
  }

  setOnBatchComplete(callback: (addresses: string[]) => void) {
    this.onBatchComplete = callback
  }

  setOnBroadcastComplete(callback: () => void) {
    this.onBroadcastComplete = callback
  }

  setOnCantMessageAddress(callback: (address: string) => void) {
    this.onCantMessageAddress = callback
  }

  setOnMessageSending(callback: (address: string) => void) {
    this.onMessageSending = callback
  }

  setOnMessageFailed(callback: (address: string) => void) {
    this.onMessageFailed = callback
  }

  setOnMessageSent(callback: (address: string) => void) {
    this.onMessageSent = callback
  }

  setOnCanMessageAddressesUpdate(callback: (addresses: string[]) => void) {
    this.onCanMessageAddressesUpdate = callback
  }

  setOnDelay(callback: (ms: number) => void) {
    this.onDelay = callback
  }
}