# Universal Blockchain Transaction Ledger (UBTL)
## Canonical JSON & Cryptographic Hashing Specification

### 1. Specification Metadata & Scope
- **Canonicalization Specification**: `ubtl-canonical-json-v1`
- **Hash Algorithm**: `SHA-256` (`sha256`)
- **Hash Version**: `v1`
- **Output Encoding**: Lowercase hexadecimal string (64 characters)

> **Conformance note**: `ubtl-canonical-json-v1` is an application-specific
> specification *based on* RFC 8785 (JSON Canonicalization Scheme — JCS)
> principles. It is **not** byte-for-byte RFC 8785/JCS conformant: it adds
> mandatory Unicode NFC normalization and a strict non-dropping policy. See
> §5 for the exact, verified divergences.

This specification defines the deterministic canonicalization and hashing engine implemented by UBTL. Every transaction payload submitted to UBTL is canonicalized and hashed on the server prior to database persistence and blockchain proposal submission.

Client-supplied hashes are **never accepted as authoritative**.

---

### 2. Deterministic Canonicalization Rules (`ubtl-canonical-json-v1`)

1. **Object Property Sorting**:
   - Property keys are sorted lexicographically by UTF-16 code units, compared **after NFC normalization of the key** (RFC 8785 §3.2.3 sorts raw UTF-16 code units; UBTL sorts NFC-normalized keys — see §5).
   - Sorting applies recursively across all nested objects and sub-documents.
2. **Array Order Preservation**:
   - Array element sequence represents business semantics and MUST NOT be sorted. Nested objects within arrays ARE subject to key sorting.
3. **Unicode Normalization**:
   - All strings undergo Unicode Normalization Form C (**NFC**) prior to serialization.
   - **Divergence**: RFC 8785 §3.2.2.2 does not itself normalize; it requires the producer to supply already-normalized input. UBTL enforces NFC internally to guarantee cross-platform hash determinism.
4. **Numeric Representation & Edge Cases**:
   - Finite numbers are serialized via ECMAScript `JSON.stringify` number formatting (RFC 8785 §3.2.2.3 style).
   - Negative zero (`-0`) is strictly normalized to `0`.
   - Non-finite numbers (`NaN`, `Infinity`, `-Infinity`) are rejected with `TypeError`.
   - **Monetary & Financial Decimals**: IEEE 754 floating-point conversion is forbidden for money. Financial amounts MUST be represented as validated fixed-scale decimal strings (e.g. `"1500000.00"`) or integer minor units according to the transaction type schema.
5. **Boolean & Null Handling**:
   - Booleans are serialized as literal `true` or `false`.
   - Explicit `null` values are preserved as literal `null`.
   - **Strict Non-Dropping Policy (divergence)**: `undefined` object properties, `undefined` array elements, `BigInt`, `Symbol`, and `Function` values are **rejected with `TypeError`**. They are NOT silently dropped or coerced to `null` (standard `JSON.stringify` drops `undefined` object properties and converts `undefined` array elements to `null`; RFC 8785 likewise only defines behaviour for the JSON data model and does not mandate this rejection).
6. **Whitespace Stripping**:
   - Zero insignificant whitespace: no spaces after colons, no spaces after commas, no indentation, no newlines.
7. **Context Isolation**:
   - The payload hash is computed **exclusively over the defined payload object**.
   - Timestamps, transport headers, correlation IDs, random nonces, or mutable status are NEVER included in the payload hash.

---

### 3. Reproducible Example & Test Vector

#### Raw Input (Unordered Object)
```json
{
  "currency": "IDR",
  "amount": "1500000.00",
  "invoiceNumber": "INV-2026-001"
}
```

#### Canonical Representation (`ubtl-canonical-json-v1`)
```json
{"amount":"1500000.00","currency":"IDR","invoiceNumber":"INV-2026-001"}
```

#### SHA-256 Digest (UTF-8 Bytes)
`756deccd4b37942bc3f88c870b43475ee29210017663feb4549805097751ef49`

Verification command:
```bash
printf '%s' '{"amount":"1500000.00","currency":"IDR","invoiceNumber":"INV-2026-001"}' | sha256sum
```

This published vector is pinned by the automated test `TC-CANON-11`; the digest
above is the value actually produced by the implementation (71 UTF-8 bytes).

---

### 4. Constant-Time Verification & Tamper Detection

UBTL provides constant-time verification using `crypto.timingSafeEqual` to prevent side-channel timing attacks:

```typescript
const bufComputed = Buffer.from(computedHash, 'utf8');
const bufStored = Buffer.from(storedHash, 'utf8');
const isAuthentic = bufComputed.length === bufStored.length && timingSafeEqual(bufComputed, bufStored);
```

If an off-chain database record has been altered, verification fails immediately, rejects confirmation, and writes an auditable `INTEGRITY_VIOLATION_TAMPER_DETECTED` security log.

Malformed expected hashes (not a 64-character lowercase hex string) are rejected before any comparison, so `timingSafeEqual` is never called with mismatched-length buffers.

---

### 5. Verified Divergences from RFC 8785 (JCS)

The following behaviours are implemented and covered by automated tests. They are
intentional and mean that `ubtl-canonical-json-v1` output is **not** guaranteed to
equal the output of a strict RFC 8785/JCS implementation for the same input:

| # | Behaviour | RFC 8785 / standard `JSON.stringify` | `ubtl-canonical-json-v1` | Test |
| :-- | :--- | :--- | :--- | :--- |
| 1 | Unicode normalization | Does not normalize; expects NFC input from producer | Always applies NFC to strings and to object keys before sorting | `TC-CANON-04` |
| 2 | `undefined` object property | Silently dropped | `TypeError` (strict non-dropping) | `TC-CANON-08` |
| 3 | `undefined` array element | Coerced to `null` | `TypeError` (strict non-dropping) | `TC-CANON-08` |
| 4 | `BigInt`, `Symbol`, `Function` | `BigInt` throws in `JSON.stringify`; `Symbol`/`Function` dropped | `TypeError` for all three | `TC-CANON-07` |
| 5 | Non-finite numbers | `JSON.stringify` emits `null` | `TypeError` | `TC-CANON-09` |

**Compatible behaviours** (identical to RFC 8785 §3.2): UTF-16 code-unit key
ordering after normalization, array order preservation, negative-zero
normalization to `0`, boolean/`null` literals, and elimination of insignificant
whitespace.

