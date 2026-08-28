export enum TokenType {
  // Types
  U0 = "U0",
  U8 = "U8",
  I8 = "I8",
  I64 = "I64",
  U64 = "U64",
  F64 = "F64",
  I32 = "I32",
  U32 = "U32",
  I16 = "I16",
  U16 = "U16",

  // Keywords
  Return = "return",
  If = "if",
  Else = "else",
  While = "while",
  For = "for",
  Class = "class",
  Switch = "switch",
  Case = "case",
  Default = "default",
  Break = "break",
  Continue = "continue",
  Union = "union",
  Try = "try",
  Catch = "catch",
  Throw = "throw",
  Reg = "reg",
  HashExe = "#exe",

  // Directives
  Directive = "Directive", // e.g. #exe

  // Literals & Identifiers
  Identifier = "Identifier",
  Number = "Number",
  String = "String",

  // Punctuation & Operators
  OpenParen = "(",
  CloseParen = ")",
  OpenBrace = "{",
  CloseBrace = "}",
  OpenBracket = "[",
  CloseBracket = "]",
  Semicolon = ";",
  Comma = ",",
  Plus = "+",
  PlusPlus = "++",
  PlusEquals = "+=",
  Minus = "-",
  MinusMinus = "--",
  MinusEquals = "-=",
  Arrow = "->",
  Star = "*",
  StarEquals = "*=",
  Slash = "/",
  SlashEquals = "/=",
  Modulo = "%",
  PercentEquals = "%=",
  Caret = "^",
  CaretEquals = "^=",
  Question = "?",
  Equals = "=",
  DoubleEquals = "==",
  NotEquals = "!=",
  LessThan = "<",
  GreaterThan = ">",
  LessEqual = "<=",
  GreaterEqual = ">=",
  LeftShift = "<<",
  RightShift = ">>",
  ShiftLeftEquals = "<<=",
  ShiftRightEquals = ">>=",
  Ampersand = "&",
  LogicalAnd = "&&",
  BitwiseOr = "|",
  LogicalOr = "||",
  Bang = "!",
  Dot = ".",
  Colon = ":",
  Ellipsis = "...",

  // End of file
  EOF = "EOF",
}

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

export class Lexer {
  private source: string;
  private position: number = 0;
  private line: number = 1;
  private column: number = 1;

  constructor(source: string) {
    this.source = source;
  }

  private advance(): string {
    const char = this.source[this.position] || '\0';
    this.position++;
    if (char === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return char;
  }

  private peek(): string {
    if (this.isAtEnd()) return '\0';
    return this.source[this.position] || '\0';
  }

  private peekNext(): string {
    if (this.position + 1 >= this.source.length) return '\0';
    return this.source[this.position + 1] || '\0';
  }

  private isAtEnd(): boolean {
    return this.position >= this.source.length;
  }

  private skipWhitespaceAndComments() {
    while (!this.isAtEnd()) {
      const c = this.peek();
      if (c === ' ' || c === '\r' || c === '\t' || c === '\n') {
        this.advance();
      } else if (c === '/' && this.peekNext() === '/') {
        // Single-line comment
        while (!this.isAtEnd() && this.peek() !== '\n') {
          this.advance();
        }
      } else if (c === '/' && this.peekNext() === '*') {
        // Multi-line comment
        this.advance(); // /
        this.advance(); // *
        while (!this.isAtEnd()) {
          if (this.peek() === '*' && this.peekNext() === '/') {
            this.advance(); // *
            this.advance(); // /
            break;
          }
          this.advance();
        }
      } else {
        break;
      }
    }
  }

  private isAlpha(c: string): boolean {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  }

  private isDigit(c: string): boolean {
    return c >= '0' && c <= '9';
  }

  private isAlphaNumeric(c: string): boolean {
    return this.isAlpha(c) || this.isDigit(c);
  }

  public tokenize(): Token[] {
    const tokens: Token[] = [];

    while (!this.isAtEnd()) {
      this.skipWhitespaceAndComments();
      if (this.isAtEnd()) break;

      const startLine = this.line;
      const startCol = this.column;
      const c = this.advance();

      const singleCharTokens: Record<string, TokenType> = {
        '(': TokenType.OpenParen, ')': TokenType.CloseParen, '{': TokenType.OpenBrace, '}': TokenType.CloseBrace,
        '[': TokenType.OpenBracket, ']': TokenType.CloseBracket, ';': TokenType.Semicolon, ',': TokenType.Comma,
        ':': TokenType.Colon, '?': TokenType.Question
      };

      if (singleCharTokens[c]) {
        tokens.push({ type: singleCharTokens[c], value: c, line: startLine, column: startCol });
        continue;
      }

      const matchNext = (expected: string, typeIfMatch: TokenType, typeIfNot: TokenType) => {
        if (this.peek() === expected) {
          this.advance();
          tokens.push({ type: typeIfMatch, value: c + expected, line: startLine, column: startCol });
        } else {
          tokens.push({ type: typeIfNot, value: c, line: startLine, column: startCol });
        }
      };

      if (c === '=') { matchNext('=', TokenType.DoubleEquals, TokenType.Equals); continue; }
      if (c === '!') { matchNext('=', TokenType.NotEquals, TokenType.Bang); continue; }
      if (c === '<') { 
        if (this.peek() === '<') { 
          this.advance();
          if (this.peek() === '=') {
            this.advance();
            tokens.push({ type: TokenType.ShiftLeftEquals, value: "<<=", line: startLine, column: startCol });
          } else {
            tokens.push({ type: TokenType.LeftShift, value: "<<", line: startLine, column: startCol });
          }
        }
        else { matchNext('=', TokenType.LessEqual, TokenType.LessThan); }
        continue; 
      }
      if (c === '>') { 
        if (this.peek() === '>') { 
          this.advance();
          if (this.peek() === '=') {
            this.advance();
            tokens.push({ type: TokenType.ShiftRightEquals, value: ">>=", line: startLine, column: startCol });
          } else {
            tokens.push({ type: TokenType.RightShift, value: ">>", line: startLine, column: startCol });
          }
        }
        else { matchNext('=', TokenType.GreaterEqual, TokenType.GreaterThan); }
        continue; 
      }
      if (c === '&') { matchNext('&', TokenType.LogicalAnd, TokenType.Ampersand); continue; }
      if (c === '*') { matchNext('=', TokenType.StarEquals, TokenType.Star); continue; }
      if (c === '/') { matchNext('=', TokenType.SlashEquals, TokenType.Slash); continue; }
      if (c === '%') { matchNext('=', TokenType.PercentEquals, TokenType.Modulo); continue; }
      if (c === '^') { matchNext('=', TokenType.CaretEquals, TokenType.Caret); continue; }
      if (c === '+') { 
        if (this.peek() === '+') { this.advance(); tokens.push({ type: TokenType.PlusPlus, value: "++", line: startLine, column: startCol }); }
        else if (this.peek() === '=') { this.advance(); tokens.push({ type: TokenType.PlusEquals, value: "+=", line: startLine, column: startCol }); }
        else { tokens.push({ type: TokenType.Plus, value: "+", line: startLine, column: startCol }); }
        continue; 
      }
      if (c === '-') { 
        if (this.peek() === '-') { this.advance(); tokens.push({ type: TokenType.MinusMinus, value: "--", line: startLine, column: startCol }); }
        else if (this.peek() === '=') { this.advance(); tokens.push({ type: TokenType.MinusEquals, value: "-=", line: startLine, column: startCol }); }
        else if (this.peek() === '>') { this.advance(); tokens.push({ type: TokenType.Arrow, value: "->", line: startLine, column: startCol }); }
        else { tokens.push({ type: TokenType.Minus, value: "-", line: startLine, column: startCol }); }
        continue; 
      }
      if (c === '|') {
        if (this.peek() === '|') {
          this.advance();
          tokens.push({ type: TokenType.LogicalOr, value: "||", line: startLine, column: startCol });
        } else {
          tokens.push({ type: TokenType.BitwiseOr, value: "|", line: startLine, column: startCol });
        }
        continue;
      }

      // Directives
      if (c === '#') {
        let directiveValue = c;
        while (this.isAlphaNumeric(this.peek())) directiveValue += this.advance();
        if (directiveValue === "#exe") {
          tokens.push({ type: TokenType.HashExe, value: "#exe", line: startLine, column: startCol });
        } else {
          tokens.push({ type: TokenType.Directive, value: directiveValue, line: startLine, column: startCol });
        }
        continue;
      }

      // Strings
      if (c === '"') {
        let stringValue = "";
        while (this.peek() !== '"' && !this.isAtEnd()) {
          if (this.peek() === '\\') {
            this.advance();
            if (!this.isAtEnd()) {
              const esc = this.advance();
              stringValue += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
            }
          } else {
            stringValue += this.advance();
          }
        }
        if (!this.isAtEnd()) this.advance();
        tokens.push({ type: TokenType.String, value: stringValue, line: startLine, column: startCol });
        continue;
      }

      // Character literals
      if (c === "'") {
        if (this.isAtEnd()) throw new Error(`Unterminated character literal at line ${startLine}, column ${startCol}`);
        if (this.peek() === "'") throw new Error(`Empty character literal at line ${startLine}, column ${startCol}`);
        let inner: string;
        if (this.peek() === '\\') {
          this.advance();
          if (this.isAtEnd()) throw new Error(`Unterminated escape in character literal at line ${startLine}, column ${startCol}`);
          const esc = this.advance();
          inner = esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
        } else {
          inner = this.advance();
        }
        if (this.peek() !== "'") {
          throw new Error(`Unterminated or multi-character literal at line ${startLine}, column ${startCol} (expected closing ')`);
        }
        this.advance();
        tokens.push({ type: TokenType.Number, value: inner.charCodeAt(0).toString(), line: startLine, column: startCol });
        continue;
      }

      // Numbers and Dot
      if (c === '.') {
        if (this.peek() === '.' && this.peekNext() === '.') {
            this.advance();
            this.advance();
            tokens.push({ type: TokenType.Ellipsis, value: "...", line: startLine, column: startCol });
            continue;
        }
        if (!this.isDigit(this.peek())) {
            tokens.push({ type: TokenType.Dot, value: '.', line: startLine, column: startCol });
            continue;
        }
      }
      
      if (this.isDigit(c) || (c === '.' && this.isDigit(this.peek()))) {
        let numValue = c;
        if (c === '0' && (this.peek() === 'x' || this.peek() === 'X')) {
          numValue += this.advance(); // consume x
          while (this.isDigit(this.peek()) || (this.peek().toLowerCase() >= 'a' && this.peek().toLowerCase() <= 'f')) {
            numValue += this.advance();
          }
        } else {
          let hasDot = c === '.';
          while (this.isDigit(this.peek()) || (!hasDot && this.peek() === '.')) {
            if (this.peek() === '.') {
               if (this.peekNext() === '.') {
                   break;
               }
               hasDot = true;
            }
            numValue += this.advance();
          }

          // Scientific notation: 1e5, 2.5E-3
          if (this.peek() === 'e' || this.peek() === 'E') {
            const beforeExp = numValue.length;
            this.advance(); // consume e/E
            let expPart = "";
            if (this.peek() === '+' || this.peek() === '-') expPart += this.advance();
            while (this.isDigit(this.peek())) expPart += this.advance();
            if (expPart.length > 0 && expPart !== "+" && expPart !== "-") {
              numValue += "e" + expPart;
            } else {
              // Not a valid exponent; rewind.
              this.position -= 1 + expPart.length;
              numValue = numValue.slice(0, beforeExp);
            }
          }
        }
        tokens.push({ type: TokenType.Number, value: numValue, line: startLine, column: startCol });
        continue;
      }

      // Identifiers and Keywords
      if (this.isAlpha(c)) {
        let idValue = c;
        while (this.isAlphaNumeric(this.peek())) idValue += this.advance();
        if (idValue === "TRUE") { tokens.push({ type: TokenType.Number, value: "1", line: startLine, column: startCol }); continue; }
        if (idValue === "FALSE") { tokens.push({ type: TokenType.Number, value: "0", line: startLine, column: startCol }); continue; }

        const keywords: Record<string, TokenType> = {
          U0: TokenType.U0, U8: TokenType.U8, I8: TokenType.I8, 
          I64: TokenType.I64, U64: TokenType.U64, F64: TokenType.F64,
          I32: TokenType.I32, U32: TokenType.U32, I16: TokenType.I16, U16: TokenType.U16,
          return: TokenType.Return, if: TokenType.If, else: TokenType.Else, while: TokenType.While, for: TokenType.For, class: TokenType.Class,
          switch: TokenType.Switch, case: TokenType.Case, default: TokenType.Default, break: TokenType.Break, continue: TokenType.Continue, union: TokenType.Union,
          try: TokenType.Try, catch: TokenType.Catch, throw: TokenType.Throw,
          reg: TokenType.Reg
        };

        tokens.push({ type: keywords[idValue] || TokenType.Identifier, value: idValue, line: startLine, column: startCol });
        continue;
      }

      throw new Error(`Unexpected character '${c}' at line ${startLine}, column ${startCol}`);
    }

    tokens.push({ type: TokenType.EOF, value: "EOF", line: this.line, column: this.column });
    return tokens;
  }
}
