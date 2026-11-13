if (typeof JSON === "undefined") JSON = {};

(function () {
  function JsonParser(text) {
    this.text = String(text);
    this.index = 0;
  }

  JsonParser.prototype.parse = function () {
    var value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail("unexpected trailing input");
    return value;
  };

  JsonParser.prototype.parseValue = function () {
    this.skipWhitespace();
    var character = this.text.charAt(this.index);
    if (character === '"') return this.parseString();
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === "-" || (character >= "0" && character <= "9")) return this.parseNumber();
    if (this.text.substr(this.index, 4) === "true") {
      this.index += 4;
      return true;
    }
    if (this.text.substr(this.index, 5) === "false") {
      this.index += 5;
      return false;
    }
    if (this.text.substr(this.index, 4) === "null") {
      this.index += 4;
      return null;
    }
    this.fail("unexpected token");
  };

  JsonParser.prototype.parseObject = function () {
    var result = {};
    this.index += 1;
    this.skipWhitespace();
    if (this.text.charAt(this.index) === "}") {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      this.skipWhitespace();
      if (this.text.charAt(this.index) !== '"') this.fail("object key must be a string");
      var key = this.parseString();
      this.skipWhitespace();
      if (this.text.charAt(this.index) !== ":") this.fail("expected ':' after object key");
      this.index += 1;
      result[key] = this.parseValue();
      this.skipWhitespace();
      var separator = this.text.charAt(this.index);
      if (separator === "}") {
        this.index += 1;
        return result;
      }
      if (separator !== ",") this.fail("expected ',' or '}' in object");
      this.index += 1;
    }
    this.fail("unterminated object");
  };

  JsonParser.prototype.parseArray = function () {
    var result = [];
    this.index += 1;
    this.skipWhitespace();
    if (this.text.charAt(this.index) === "]") {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      result.push(this.parseValue());
      this.skipWhitespace();
      var separator = this.text.charAt(this.index);
      if (separator === "]") {
        this.index += 1;
        return result;
      }
      if (separator !== ",") this.fail("expected ',' or ']' in array");
      this.index += 1;
    }
    this.fail("unterminated array");
  };

  JsonParser.prototype.parseString = function () {
    var result = "";
    this.index += 1;
    while (this.index < this.text.length) {
      var character = this.text.charAt(this.index);
      this.index += 1;
      if (character === '"') return result;
      if (character === "\\") {
        if (this.index >= this.text.length) this.fail("unterminated escape sequence");
        var escape = this.text.charAt(this.index);
        this.index += 1;
        if (escape === '"' || escape === "\\" || escape === "/") result += escape;
        else if (escape === "b") result += "\b";
        else if (escape === "f") result += "\f";
        else if (escape === "n") result += "\n";
        else if (escape === "r") result += "\r";
        else if (escape === "t") result += "\t";
        else if (escape === "u") {
          var hex = this.text.substr(this.index, 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("invalid unicode escape");
          result += String.fromCharCode(parseInt(hex, 16));
          this.index += 4;
        } else this.fail("invalid escape sequence");
      } else {
        if (character.charCodeAt(0) < 32) this.fail("unescaped control character");
        result += character;
      }
    }
    this.fail("unterminated string");
  };

  JsonParser.prototype.parseNumber = function () {
    var match = this.text.substring(this.index).match(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+\-]?[0-9]+)?/);
    if (!match) this.fail("invalid number");
    this.index += match[0].length;
    return Number(match[0]);
  };

  JsonParser.prototype.skipWhitespace = function () {
    while (this.index < this.text.length && /[\t\n\r ]/.test(this.text.charAt(this.index))) this.index += 1;
  };

  JsonParser.prototype.fail = function (message) {
    throw new SyntaxError(message + " at position " + this.index);
  };

  function quote(value) {
    var result = '"';
    for (var index = 0; index < value.length; index += 1) {
      var character = value.charAt(index);
      var code = value.charCodeAt(index);
      if (character === '"') result += '\\"';
      else if (character === "\\") result += "\\\\";
      else if (character === "\b") result += "\\b";
      else if (character === "\f") result += "\\f";
      else if (character === "\n") result += "\\n";
      else if (character === "\r") result += "\\r";
      else if (character === "\t") result += "\\t";
      else if (code < 32 || code === 0x2028 || code === 0x2029) result += "\\u" + ("0000" + code.toString(16)).slice(-4);
      else result += character;
    }
    return result + '"';
  }

  function containsReference(stack, value) {
    for (var index = 0; index < stack.length; index += 1) {
      if (stack[index] === value) return true;
    }
    return false;
  }

  function stringifyValue(value, stack, inArray) {
    if (value === null) return "null";
    var valueType = typeof value;
    if (valueType === "string") return quote(value);
    if (valueType === "number") return isFinite(value) ? String(value) : "null";
    if (valueType === "boolean") return value ? "true" : "false";
    if (valueType === "undefined" || valueType === "function") return inArray ? "null" : undefined;
    if (valueType !== "object") return inArray ? "null" : undefined;
    if (containsReference(stack, value)) throw new TypeError("Converting circular structure to JSON");

    stack.push(value);
    var parts = [];
    var index;
    if (value instanceof Array) {
      for (index = 0; index < value.length; index += 1) parts.push(stringifyValue(value[index], stack, true));
      stack.pop();
      return "[" + parts.join(",") + "]";
    }

    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      var encoded = stringifyValue(value[key], stack, false);
      if (typeof encoded !== "undefined") parts.push(quote(String(key)) + ":" + encoded);
    }
    stack.pop();
    return "{" + parts.join(",") + "}";
  }

  if (typeof JSON.parse !== "function") {
    JSON.parse = function (text) {
      return new JsonParser(text).parse();
    };
  }

  if (typeof JSON.stringify !== "function") {
    JSON.stringify = function (value) {
      return stringifyValue(value, [], false);
    };
  }
}());
