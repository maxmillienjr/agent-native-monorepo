/**
 * The vector codec.
 *
 * An embedding is recorded as base64 float32 rather than a JSON float array.
 * Measured over 768 dimensions one vector is 16,345 bytes as JSON and 4,096 as
 * base64 float32, and a trial makes eighteen embedding calls — 303 KB against
 * 76 KB, for a file that is committed. The precision loss is not a loss:
 * `semantic_facts.embedding` is `vector(768)` and pgvector's `vector` is an
 * array of `float4`, so the database would round the same values on the way in.
 *
 * Byte order is written explicitly rather than taken from `Float32Array`, whose
 * layout follows the platform. A cassette recorded on one machine and replayed
 * on another has to decode to the same numbers.
 */

const BYTES_PER_FLOAT = 4;
const LITTLE_ENDIAN = true;

export function encodeFloat32Base64(values: readonly number[] | Float32Array): string {
  const source = values instanceof Float32Array ? values : Float32Array.from(values);
  const bytes = new DataView(new ArrayBuffer(source.length * BYTES_PER_FLOAT));

  for (let i = 0; i < source.length; i += 1) {
    bytes.setFloat32(i * BYTES_PER_FLOAT, source[i] ?? 0, LITTLE_ENDIAN);
  }

  return Buffer.from(bytes.buffer).toString('base64');
}

export function decodeFloat32Base64(float32Base64: string): number[] {
  const buffer = Buffer.from(float32Base64, 'base64');

  if (buffer.byteLength % BYTES_PER_FLOAT !== 0) {
    throw new RangeError(
      `recorded vector is ${buffer.byteLength} bytes, which is not a whole number of float32 values`,
    );
  }

  const bytes = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const values: number[] = [];
  for (let i = 0; i < buffer.byteLength / BYTES_PER_FLOAT; i += 1) {
    values.push(bytes.getFloat32(i * BYTES_PER_FLOAT, LITTLE_ENDIAN));
  }

  return values;
}

/** Whether a recorded response can be stored as a vector rather than as a value. */
export function isNumberVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number');
}
