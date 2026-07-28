type Listener<T> = (detail: T) => void;

export class Emitter<Events extends object = Record<string, unknown>> {
  #listeners = new Map<keyof Events, Set<Listener<Events[keyof Events]>>>();

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('listener 必须是函数');
    }
    const listeners = this.#listeners.get(type) ?? new Set<Listener<Events[keyof Events]>>();
    listeners.add(listener as Listener<Events[keyof Events]>);
    this.#listeners.set(type, listeners);
    return () => this.off(type, listener);
  }

  once<K extends keyof Events>(type: K, listener: Listener<Events[K]>): () => void {
    const unsubscribe = this.on(type, (detail) => {
      unsubscribe();
      listener(detail);
    });
    return unsubscribe;
  }

  off<K extends keyof Events>(type: K, listener: Listener<Events[K]>): void {
    const listeners = this.#listeners.get(type);
    listeners?.delete(listener as Listener<Events[keyof Events]>);
    if (listeners?.size === 0) {
      this.#listeners.delete(type);
    }
  }

  emit<K extends keyof Events>(type: K, detail: Events[K]): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      try {
        listener(detail);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
