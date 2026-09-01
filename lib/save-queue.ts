/**
 * Browser fetches may finish out of order. For full-replacement board PUTs,
 * that can let an older payload overwrite a newer one. This queue makes the
 * wire order the durable order and gives desktop shutdown one promise to await.
 */
export class SaveQueue<T> {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly write: (value: T) => Promise<void>) {}

  enqueue(value: T): Promise<void> {
    const result = this.tail.then(() => this.write(value));
    // A failed write is reported to its caller but must not poison every later
    // retry chained behind it.
    this.tail = result.catch(() => {});
    return result;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}
