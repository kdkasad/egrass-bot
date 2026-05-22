export class BoundedMap<K, V> {
	#map: Map<K, V> = new Map();
	#maxSize: number;

	constructor(maxSize: number) {
		this.#maxSize = maxSize;
	}

	set(key: K, value: V) {
		this.#map.set(key, value);
		if (this.#map.size > this.#maxSize) {
			const oldest = this.#map.keys().next().value!;
			this.#map.delete(oldest);
		}
	}

	get(key: K): V | undefined {
		return this.#map.get(key);
	}
}
