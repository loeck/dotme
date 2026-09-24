/** Reverse-order cleanup also covers constructors that fail partway through. */
export class ResourceScope {
  private readonly resources: Array<{ dispose(): void }> = []
  private disposed = false

  own<T extends { dispose(): void }>(resource: T): T {
    if (this.disposed) resource.dispose()
    else this.resources.push(resource)
    return resource
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const resource of this.resources.toReversed()) {
      try {
        resource.dispose()
      } catch {
        /* Continue releasing independent allocations. */
      }
    }
    this.resources.length = 0
  }
}
