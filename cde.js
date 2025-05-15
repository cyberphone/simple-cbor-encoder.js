////////////////////////////////////////////////////////////////////////////////////
// Minimalist CBOR encoder supporting the CBOR::Core primitives:
//   tstr, bstr, int, bigint, float (16/32/64 bit), 
//   bool, null, tagged data (CBOR major type 6), and
//   simple (CBOR major type 7).
// 
// Compatible with recent versions of node.js and browsers.
//
// Usage:
//   Plain vanilla numbers MUST be integers, otherwise an exception will be thrown.
//   Floating point, Tag, and Simple objects MUST be wrapped.  See example.
// 
// (C) Anders Rundgren, 2024, 2025
////////////////////////////////////////////////////////////////////////////////////

class CBOR {

   // Float wrapper
   static Float = class {

    #encoded;
    #tag;

    constructor(value) {
      // Begin catching the F16 edge cases.
      this.#tag = 0xf9;
      if (Number.isNaN(value)) {
        this.#encoded = CBOR.#int16ToByteArray(0x7e00);
      } else if (!Number.isFinite(value)) {
        this.#encoded = CBOR.#int16ToByteArray(value < 0 ? 0xfc00 : 0x7c00);
      } else if (value == 0) {  // works for -0 as well!
        this.#encoded = CBOR.#int16ToByteArray(Object.is(value, -0) ? 0x8000 : 0x0000);
      } else {
        // It is apparently a genuine (non-zero) number.
        // The following code depends on that Math.fround works as expected.
        let f32 = Math.fround(value);
        const buffer = new ArrayBuffer(8);
        new DataView(buffer).setFloat64(0, value, false);
        const u8 = new Uint8Array(buffer)
        let f32exp;
        let f32signif;
        while (true) {  // "goto" surely beats quirky loop/break/return/flag constructs...
          if (f32 == value) {
            // Nothing was lost during the conversion, F32 or F16 is on the menu.
            f32exp = ((u8[0] & 0x7f) << 4) + ((u8[1] & 0xf0) >> 4) - 0x380;
            f32signif = ((u8[1] & 0x0f) << 19) + (u8[2] << 11) + (u8[3] << 3) + (u8[4] >> 5);
            // Very small F32 numbers may require subnormal representation.
            if (f32exp <= 0) {
              // The implicit "1" becomes explicit using subnormal representation.
              f32signif += 0x800000;
              // Denormalize by shifting right 1-23 positions.
              f32signif >>= (1 - f32exp);
              f32exp = 0;
              // Subnormal F32 cannot be represented by F16, stick to F32.
              break;
            }
            // If F16 would lose precision, stick to F32.
            if (f32signif & 0x1fff) {
              break;
            }
            // Setup for F16.
            let f16exp = f32exp - 0x70;
            // Too small or too big for F16, or running into F16 NaN/Infinity space.
            if (f16exp <= -10 || f16exp > 30) {
              break;
            }
            let f16signif = f32signif >> 13;
            // Finally, check if we need to denormalize F16.
            if (f16exp <= 0) {
              if (f16signif & ((1 << (1 - f16exp)) - 1)) {
                // Losing bits is not an option, stick to F32.
                break;
              }
              // The implicit "1" becomes explicit using subnormal representation.
              f16signif += 0x400;
              // Shift significand into position.
              f16signif >>= (1 - f16exp);
              // Valid and denormalized F16.
              f16exp = 0;
            }
            // A rarity, 16 bits turned out being sufficient for representing the number.
            this.#encoded = CBOR.#int16ToByteArray( 
                // Put sign bit in position.
                ((u8[0] & 0x80) << 8) +
                // Exponent.  Put it in front of significand.
                (f16exp << 10) +
                // Significand.
                f16signif);
          } else {
            // Converting value to F32 returned a truncated result.
            // Full 64-bit representation is required.
            this.#tag = 0xfb;
            this.#encoded = u8;
          }
          // Common F16 and F64 return point.
          return;
        }
        // Broken loop: 32 bits are apparently needed for maintaining magnitude and precision.
        this.#tag = 0xfa;
        let f32bin =
            // Put sign bit in position. Why not << 24?  JS shift doesn't work above 2^31...
            ((u8[0] & 0x80) * 0x1000000) +
            // Exponent.  Put it in front of significand (<< 23).
            (f32exp * 0x800000) +
            // Significand.
            f32signif;
        this.#encoded = CBOR.#addArrays(CBOR.#int16ToByteArray(f32bin / 0x10000),
                                        CBOR.#int16ToByteArray(f32bin % 0x10000));
      }
    }

    encode = function() {
      return CBOR.#addArrays(new Uint8Array([this.#tag]), this.#encoded);
    }
  }

  // Tag wrapper
  static Tag = class {

    #encoded;

    constructor(tagNumber /* BigInt */, object) {
      this.#encoded = CBOR.#addArrays(CBOR.#encodeInteger(0xc0, tagNumber),
                                      CBOR.encode(object));
    }

    encode = function() {
      return this.#encoded;
    }
  }

  // Simple wrapper
  static Simple = class {

    #encoded;

    constructor(value) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 255 || (value > 23 && value < 32)) {
        CBOR.#error('Invalid simple argument: ' + value);
      }
      this.#encoded = CBOR.#encodeInteger(0xe0, BigInt(value));
    }

    encode = function() {
      return this.#encoded;
    }
  }

  // The Proxy concept enables checks for invocation by "new" and number of arguments.
  static #handler = class {

    constructor(numberOfArguments) {
      this.numberOfArguments = numberOfArguments;
    }

    apply(target, thisArg, argumentsList) {
      if (argumentsList.length != this.numberOfArguments) {
        CBOR.#error("CBOR." + target.name + " expects " + this.numberOfArguments + " argument(s)");
      }
      return new target(...argumentsList);
    }

    construct(target, args) {
      CBOR.#error("CBOR." + target.name + " does not permit \"new\"");
    }
  }

  static Float = new Proxy(CBOR.Float, new CBOR.#handler(1));
  static Tag = new Proxy(CBOR.Tag, new CBOR.#handler(2));
  static Simple = new Proxy(CBOR.Simple, new CBOR.#handler(1));

  static #addArrays = function(a, b) {
    let result = new Uint8Array(a.length + b.length);
    result.set(a);
    result.set(b, a.length);
    return result;
  }

  static #encodeString = function(tag, binary) {
    return CBOR.#addArrays(CBOR.#encodeInteger(tag, BigInt(binary.length)), binary);
  }

  static #int16ToByteArray = function(int16) {
    return new Uint8Array([int16 / 256, int16 % 256]);
  }

  static #encodeMap = function(object) {
    let result = CBOR.#encodeInteger(0xa0, BigInt(object.size));
    let encPair = {};
    object.forEach((value, key) => {
      let binaryKey = CBOR.encode(key);
      encPair[CBOR.toHex(binaryKey)] = CBOR.#addArrays(binaryKey, CBOR.encode(value));
    });
    Object.keys(encPair).sort().forEach((key) => {
      result = CBOR.#addArrays(result, encPair[key]);
    });
    return result;    
  }

  static #encodeInteger = function(tag, value) {
    let neg = value < 0n;
    // Only applies to "int" and "bigint"
    if (neg) {
      value = ~value;
      tag = 0x20;
    }
    // Convert BigInt to Uint8Array (but with a twist).
    let array = [];
    do {
      array.push(Number(value & 255n));
    } while (value >>= 8n);
    let length = array.length;
    // Prepare for "int" encoding (1, 2, 4, 8).  Only 3, 5, 6, and 7 need an action.
    while (length < 8 && length > 2 && length != 4) {
      array.push(0);
      length++;
    }
    // Make big endian.
    let byteArray = new Uint8Array(array.reverse());
    // Does this number qualify as a "bigint"?
    if (length <= 8) {
      // Apparently not, encode it as "int".
      if (length == 1 && byteArray[0] <= 23) {
        return new Uint8Array([tag | byteArray[0]]);
      }
      let modifier = 24;
      while (length >>= 1) {
        modifier++;
      }
      return CBOR.#addArrays(new Uint8Array([tag | modifier]), byteArray);
    }
    // True "BigInt".
    return CBOR.#addArrays(new Uint8Array([neg ? 0xc3 : 0xc2]),
                           CBOR.#encodeString(0x40, byteArray));

  }

  static #error = function(message) {
    throw new Error(message);
  }

  // The primary method...
  static encode = function(object) {
    if (object === null) {
      return new Uint8Array([0xf6]);
    }

    if (object instanceof CBOR.Float ||
        object instanceof CBOR.Tag || object instanceof CBOR.Simple) {
      return object.encode();
    }

    if (object instanceof Uint8Array) {
      return CBOR.#encodeString(0x40, object);
    }

    if (object instanceof Map) {
      return CBOR.#encodeMap(object);
    }

    if (typeof object != 'object') {
      switch (typeof object) {
        case 'number':
          if (!Number.isSafeInteger(object)) CBOR.#error('Invalid integer: ' + object);
          object = BigInt(object);
          // Fallthrough
        case 'bigint':
          return CBOR.#encodeInteger(0x00, object);

        case 'string':
          return CBOR.#encodeString(0x60, new TextEncoder().encode(object));

        case 'boolean':
          return new Uint8Array([object ? 0xf5 : 0xf4]);

        default:
          CBOR.#error('Unexpected object: ' + object);
      }
    }
    
    if (Array.isArray(object)) {
      let result = CBOR.#encodeInteger(0x80, BigInt(object.length));
      object.forEach((element) => {
        result = CBOR.#addArrays(result, CBOR.encode(element));
      });
      return result;
    } 
    // JavaScript object {}
    return CBOR.#encodeMap(new Map(Object.entries(object)));
  }

  static #oneHex = function(digit) {
    return String.fromCharCode(digit < 10 ? (0x30 + digit) : (0x57 + digit));
  }

  static #twoHex = function(byte) {
    return CBOR.#oneHex(byte / 16) + CBOR.#oneHex(byte % 16);
  }

  // Nice to have...
  static toHex(binary) {
    let hexString = '';
    binary.forEach((element) => {
      hexString += CBOR.#twoHex(element);
    });
    return hexString;
  }
}

// Testing/Demo

function test(description, object, reference) {
  let toHex = CBOR.toHex(CBOR.encode(object));
  console.log(description + ':\n' + toHex + '\n')
  if (toHex.length != reference.length) {
    throw new Error('Length\n' + reference);
  }
  for (let i = 0; i < toHex.length; i++) if (toHex.charCodeAt(i) != reference.charCodeAt(i)) {
    let p = "^";
    while (--i >= 0) p = ' ' + p;
    throw new Error(reference + '\n' + p);
  }
}

let map = {
  "int": 6,                   // The Number type MUST in this implementation be a valid JS Integer.
  "float": CBOR.Float(50),    // Ugly? The number of discrete Float variables are typically few.
  "bigint": 10000000000000000000000000002n,  // 2n would of course still return 0x02.
  "binary": new Uint8Array([1, 2, 3, 4, -1]),
  "string": "hi there!",
  "simple": CBOR.Simple(59),
  "bool": true,
  "null": null,
  "jmap": new Map()  // The more advanced map, permitting arbitrary key expressions.
    .set(3, "three")
    .set(1n, "one"),
  "tag": CBOR.Tag(6789n, {"key": "value"}),
  "array": [4, "str", CBOR.Float(Number.NaN), CBOR.Float(0.333333333333333), false]
}
test("General CBOR", map, 'ab63696e740663746167d91a85a1636b65796576616c75656462\
6f6f6cf5646a6d6170a201636f6e6503657468726565646e756c6cf665617272617985046373747\
2f97e00fb3fd555555555554ff465666c6f6174f9524066626967696e74c24c204fce5e3e250261\
100000026662696e6172794501020304ff6673696d706c65f83b66737472696e676968692074686\
5726521');

// Read a single data item.
test("Float data item", map.float, 'f95240');
// Remove key and value.
delete map.float;  

// Add a new key and value.
map.jmap.set(-1, CBOR.Float(0.3));
test("Transformed CBOR", map, 'aa63696e740663746167d91a85a1636b65796576616c7565\
64626f6f6cf5646a6d6170a301636f6e650365746872656520fb3fd3333333333333646e756c6cf\
6656172726179850463737472f97e00fb3fd555555555554ff466626967696e74c24c204fce5e3e\
250261100000026662696e6172794501020304ff6673696d706c65f83b66737472696e676968692\
0746865726521');

let floats = [
  0.0,
  -0.0,
  Infinity,
  -Infinity,
  NaN,
  -5.960464477539062e-8,
  -5.960464477539063e-8,
  -5.960464477539064e-8,
  -5.960465188081798e-8,
  0.00006097555160522461,
  65504.0,
  65504.00390625,
  65536.0,
  10.559998512268066,
  10.559998512268068,
  3.4028234663852886e+38,
  3.402823466385289e+38,
  1.4012984643248169e-45,
  1.401298464324817e-45,
  1.4012984643248174e-45,
  1.4012986313726115e-45,
  1.1754942106924411e-38,
  5.0e-324,
  -1.7976931348623157e+308
];
for (let i = 0; i < floats.length; i++) floats[i] = CBOR.Float(floats[i]);
test("Floating Point", floats, '9818f90000f98000f97c00f9fc00f97e00fbbe6ffffffff\
ffffff98001fbbe70000000000001fab3800001f903fff97bfffa477fe001fa47800000fa4128f5\
c1fb40251eb820000001fa7f7ffffffb47efffffe0000001fb369ffffffffffffffa00000001fb3\
6a0000000000001fb36a0000020000000fa007ffffffb0000000000000001fbffefffffffffffff');

let ints = [
  0,
  -1,
  2.0, // Note: JavaScript does not tag this any different than 2
  23,
  24,
  -24,
  -25,
  255,
  256,
  -256,
  -257,
  2147483648,
  4294967295,
  4294967296,
  -4294967296,
  -4294967297,
  1099511627775,
  9007199254740991,
  1n,
  18446744073709551615n,
  18446744073709551616n,
  -18446744073709551616n,
  -18446744073709551617n
];

test("Integers", ints, '9700200217181837381818ff19010038ff3901001a800000001aff\
ffffff1b00000001000000003affffffff3b00000001000000001b000000ffffffffff1b001fff\
ffffffffff011bffffffffffffffffc2490100000000000000003bffffffffffffffffc3490100\
00000000000000');

// An unwrapped "Number", MUST be a JavaScript-constrained integer
[1.5, 9007199254740992].forEach((element) => {
  try {
    CBOR.encode(element);
    throw new Error("Should fail");
  } catch (error) {
    if (!error.toString().includes("Invalid integer: " + element)) {
      throw new Error("Error in error");
    }
  }
});
