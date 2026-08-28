import type { Token } from "./lexer.js";
import { TokenType } from "./lexer.js";
import * as AST from "./ast.js";

/**
 * Sandboxed evaluator for #exe blocks. Supports numbers, strings, + - * / %
 * and Yield(expr). Deliberately does NOT evaluate arbitrary JavaScript.
 */
class ExeEvaluator {
  private src: string = "";
  private pos: number = 0;
  public result: unknown = undefined;

  public evaluate(text: string): unknown {
    this.src = text;
    this.pos = 0;
    this.result = undefined;
    const val = this.parseExpr();
    return val;
  }

  private skipWs(): void { while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++; }
  private peek(): string { return this.src[this.pos] ?? ""; }

  private parseExpr(): unknown {
    let left = this.parseTerm();
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === "+" || c === "-") {
        this.pos++;
        const right = this.parseTerm();
        left = c === "+" ? this.add(left, right) : this.subNums(left, right);
      } else break;
    }
    return left;
  }

  private parseTerm(): unknown {
    let left = this.parseFactor();
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === "*" || c === "/" || c === "%") {
        this.pos++;
        const right = this.parseFactor();
        left = this.mulDivMod(left, right, c);
      } else break;
    }
    return left;
  }

  private parseFactor(): unknown {
    this.skipWs();
    const c = this.peek();
    if (c === "(") {
      this.pos++;
      const v = this.parseExpr();
      this.skipWs();
      if (this.peek() !== ")") throw new Error("#exe: expected ')'");
      this.pos++;
      return v;
    }
    if (c === "-") {
      this.pos++;
      const n = Number(this.parseFactor());
      if (Number.isNaN(n)) throw new Error("#exe: bad operand for unary '-'");
      return -n;
    }
    if (c === '"') return this.parseString();

    const rest = this.src.slice(this.pos);
    const idMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (idMatch) {
      const name = idMatch[0]!;
      this.pos += name.length;
      this.skipWs();
      if (name === "Yield" && this.peek() === "(") {
        this.pos++;
        const arg = this.parseExpr();
        this.skipWs();
        if (this.peek() !== ")") throw new Error("#exe: expected ')' after Yield argument");
        this.pos++;
        this.result = arg;
        return arg;
      }
      if (name === "TRUE") return 1;
      if (name === "FALSE") return 0;
      throw new Error(`#exe: unsupported identifier '${name}'`);
    }
    const numMatch = /^(0[xX][0-9a-fA-F]+|\d+(\.\d+)?([eE][+-]?\d+)?)/.exec(rest);
    if (numMatch) {
      this.pos += numMatch[0].length;
      return Number(numMatch[0]);
    }
    throw new Error(`#exe: unexpected character '${c}'`);
  }

  private parseString(): string {
    this.pos++; // opening quote
    let out = "";
    while (this.pos < this.src.length && this.src[this.pos] !== '"') {
      const ch = this.src[this.pos++]!;
      if (ch === "\\" && this.pos < this.src.length) {
        const esc = this.src[this.pos++]!;
        out += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc;
      } else {
        out += ch;
      }
    }
    if (this.src[this.pos] !== '"') throw new Error("#exe: unterminated string");
    this.pos++;
    return out;
  }

  private toNum(v: unknown, op: string): number {
    const n = Number(v);
    if (Number.isNaN(n)) throw new Error(`#exe: non-numeric operand for '${op}'`);
    return n;
  }
  private add(a: unknown, b: unknown): unknown {
    if (typeof a === "string" || typeof b === "string") return String(a) + String(b);
    return this.toNum(a, "+") + this.toNum(b, "+");
  }
  private subNums(a: unknown, b: unknown): number { return this.toNum(a, "-") - this.toNum(b, "-"); }
  private mulDivMod(a: unknown, b: unknown, op: string): number {
    const x = this.toNum(a, op);
    const y = this.toNum(b, op);
    if (op === "*") return x * y;
    if (op === "/") return x / y;
    return x % y;
  }
}

export class Parser {
  private tokens: Token[];
  private current: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.current]!;
  }

  private previous(): Token {
    return this.tokens[this.current - 1]!;
  }

  private isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  private advance(): Token {
    if (!this.isAtEnd()) this.current++;
    return this.previous();
  }

  private check(type: TokenType): boolean {
    if (this.isAtEnd()) return false;
    return this.peek().type === type;
  }

  private match(...types: TokenType[]): boolean {
    for (const type of types) {
      if (this.check(type)) {
        this.advance();
        return true;
      }
    }
    return false;
  }

  private consume(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    throw new Error(`Parse Error: ${message} at line ${this.peek().line}, col ${this.peek().column}`);
  }

  // ==== Parsing Logic ====

  public parse(): AST.Program {
    const statements: AST.Statement[] = [];
    while (!this.isAtEnd()) {
      // Skip directives for now in the parser
      if (this.match(TokenType.Directive)) {
        // Skip until we see matching brackets or just skip the statement
        // For #exe { ... } we might just skip the block.
        if (this.match(TokenType.OpenBrace)) {
          let depth = 1;
          while (depth > 0 && !this.isAtEnd()) {
            if (this.match(TokenType.OpenBrace)) depth++;
            else if (this.match(TokenType.CloseBrace)) depth--;
            else this.advance();
          }
        }
        continue;
      }
      const decl = this.declaration();
      if (Array.isArray(decl)) statements.push(...decl);
      else statements.push(decl as AST.Statement);
    }
    return { type: "Program", body: statements };
  }

  private definedTypes = new Set<string>(["CTask"]);

  private isType(token: Token): boolean {
    if ([TokenType.U0, TokenType.I64, TokenType.U64, TokenType.F64, TokenType.I32, TokenType.U32, TokenType.I16, TokenType.U16, TokenType.I8, TokenType.U8].includes(token.type)) return true;
    if (token.type === TokenType.Identifier && this.definedTypes.has(token.value)) return true;
    return false;
  }

  private parseType(): AST.Type {
    const typeToken = this.advance();
    return typeToken.value as AST.Type;
  }

  private declaration(): AST.Statement | AST.Statement[] {
    if (this.match(TokenType.HashExe)) {
      this.consume(TokenType.OpenBrace, "Expected '{' after #exe");
      let bodyText = "";
      while (!this.check(TokenType.CloseBrace) && !this.isAtEnd()) {
        const tok = this.advance();
        if (tok.type === TokenType.String) bodyText += '"' + tok.value.replace(/\n/g, "\\n") + '" ';
        else bodyText += tok.value + " ";
      }
      this.consume(TokenType.CloseBrace, "Expected '}' after #exe block");
      // Sandboxed evaluation (no arbitrary JS): numbers/strings/arithmetic/Yield.
      const exe = new ExeEvaluator();
      try {
        const ev = exe.evaluate(bodyText);
        if (exe.result === undefined && typeof ev === "string") console.log(ev);
      } catch (e) { console.error("Error evaluating #exe:", e); }
      return { type: "BlockStatement", body: [] };
    }

    if (this.match(TokenType.Class) || this.match(TokenType.Union)) {
      const isUnion = this.previous().type === TokenType.Union;
      const name = this.consume(TokenType.Identifier, "Expected class/union name.").value;
      this.definedTypes.add(name);
      this.consume(TokenType.OpenBrace, "Expected '{' before body.");
      const members: AST.VariableDeclaration[] = [];
      while (!this.check(TokenType.CloseBrace) && !this.isAtEnd()) {
        const typeStr = this.parseType();
        let memPointerDepth = 0;
        while (this.match(TokenType.Star)) memPointerDepth++;
        const memName = this.consume(TokenType.Identifier, "Expected member name.").value;
        
        let arraySize: AST.Expression | undefined = undefined;
        while (this.match(TokenType.OpenBracket)) {
           if (!this.check(TokenType.CloseBracket)) {
               arraySize = this.expression();
           }
           this.consume(TokenType.CloseBracket, "Expected ']'");
           memPointerDepth++;
        }
        this.consume(TokenType.Semicolon, "Expected ';' after member.");
        members.push({ type: "VariableDeclaration", varType: typeStr, name: memName, initializer: null, pointerDepth: memPointerDepth, arraySize } as any);
      }
      this.consume(TokenType.CloseBrace, "Expected '}' after body.");
      this.consume(TokenType.Semicolon, "Expected ';' after declaration.");
      return { type: "ClassDeclaration", name, members, isUnion };
    }

    if (this.isType(this.peek())) {
      const typeStr = this.parseType();
      
      let firstPointerDepth = 0;
      while (this.match(TokenType.Star)) firstPointerDepth++;

      if (this.match(TokenType.Reg)) {
          if (this.check(TokenType.Identifier)) this.advance();
      }
      
      let extraParens = 0;
      while (this.match(TokenType.OpenParen)) {
          extraParens++;
          while (this.match(TokenType.Star)) firstPointerDepth++;
      }
      
      let firstName = this.consume(TokenType.Identifier, "Expected identifier after type.").value;
      
      let funcPointerDepth = firstPointerDepth;
      let arraySize: AST.Expression | undefined = undefined;
      while (this.match(TokenType.OpenBracket)) {
         if (!this.check(TokenType.CloseBracket)) {
             arraySize = this.expression();
         }
         this.consume(TokenType.CloseBracket, "Expected ']'");
         funcPointerDepth++;
      }

      let isFuncPtr = false;
      while (extraParens > 0) {
          this.consume(TokenType.CloseParen, "Expected ')' after function pointer identifier.");
          extraParens--;
          isFuncPtr = true;
      }
      
      if (isFuncPtr) {
          this.consume(TokenType.OpenParen, "Expected '(' for function pointer parameters.");
          while (!this.check(TokenType.CloseParen) && !this.isAtEnd()) {
             this.advance(); 
          }
          this.consume(TokenType.CloseParen, "Expected ')' after function pointer parameters.");
      }
      
      if (!isFuncPtr && this.check(TokenType.OpenParen)) {
        this.consume(TokenType.OpenParen, "Expected '(' after function name.");
        const params: AST.Parameter[] = [];
        let isVararg = false;
        if (!this.check(TokenType.CloseParen)) {
          do {
            if (this.match(TokenType.Ellipsis)) {
                isVararg = true;
                break;
            }
            if (this.isType(this.peek())) {
              const pType = this.parseType();
              let pPointerDepth = 0;
              while (this.match(TokenType.Star)) pPointerDepth++;
              let pName = "";
              if (this.match(TokenType.OpenParen)) {
                 while (this.match(TokenType.Star)) pPointerDepth++;
                 pName = this.consume(TokenType.Identifier, "Expected identifier in function pointer.").value;
                 this.consume(TokenType.CloseParen, "Expected ')' in function pointer.");
                 this.consume(TokenType.OpenParen, "Expected '(' in function pointer.");
                 while (!this.check(TokenType.CloseParen) && !this.isAtEnd()) this.advance();
                 this.consume(TokenType.CloseParen, "Expected ')' in function pointer.");
              } else {
                 pName = this.consume(TokenType.Identifier, "Expected parameter name.").value;
              }
              
              let defaultValue: AST.Expression | null = null;
              if (this.match(TokenType.Equals)) {
                defaultValue = this.expression();
              }
              params.push({ varType: pType, name: pName, pointerDepth: pPointerDepth, defaultValue });
            } else {
               throw new Error(`Expected parameter type at line ${this.peek().line}`);
            }
          } while (this.match(TokenType.Comma));
        }
        this.consume(TokenType.CloseParen, "Expected ')' after parameters.");
        const body = this.blockStatement();
        return {
          type: "FunctionDeclaration",
          returnType: typeStr,
          name: firstName,
          params,
          body,
          isVararg
        };
      }
      
      const decls: AST.Statement[] = [];
      let currentPointerDepth = funcPointerDepth;
      let currentName = firstName;
      
      while (true) {
        let initializer: AST.Expression | null = null;
        if (this.match(TokenType.Equals)) {
          initializer = this.expression();
        }
        decls.push({
          type: "VariableDeclaration",
          varType: typeStr,
          name: currentName,
          initializer,
          pointerDepth: currentPointerDepth,
          arraySize
        } as any);
        
        if (this.match(TokenType.Comma)) {
           currentPointerDepth = 0;
           while (this.match(TokenType.Star)) currentPointerDepth++;
           
           if (this.match(TokenType.Reg)) {
               if (this.check(TokenType.Identifier)) this.advance();
           }
           
           currentName = this.consume(TokenType.Identifier, "Expected identifier after comma.").value;
           arraySize = undefined;
           while (this.match(TokenType.OpenBracket)) {
              if (!this.check(TokenType.CloseBracket)) {
                  arraySize = this.expression();
              }
              this.consume(TokenType.CloseBracket, "Expected ']'");
              currentPointerDepth++;
           }
           continue;
        }
        break;
      }
      
      this.consume(TokenType.Semicolon, "Expected ';' after variable declaration.");
      return decls;
    }

    return this.statement();
  }

  private statement(): AST.Statement {
    if (this.match(TokenType.If)) return this.ifStatement();
    if (this.match(TokenType.While)) return this.whileStatement();
    if (this.match(TokenType.For)) return this.forStatement();
    if (this.match(TokenType.Switch)) return this.switchStatement();
    if (this.match(TokenType.Return)) return this.returnStatement();
    if (this.match(TokenType.Break)) {
       this.consume(TokenType.Semicolon, "Expected ';' after break.");
       return { type: "BreakStatement" };
    }
    if (this.match(TokenType.Continue)) {
       this.consume(TokenType.Semicolon, "Expected ';' after continue.");
       return { type: "ContinueStatement" };
    }
    if (this.match(TokenType.Try)) return this.tryStatement();
    if (this.match(TokenType.Throw)) return this.throwStatement();
    if (this.check(TokenType.OpenBrace)) return this.blockStatement();

    return this.expressionStatement();
  }

  private ifStatement(): AST.IfStatement {
    this.consume(TokenType.OpenParen, "Expected '(' after 'if'.");
    const test = this.expression();
    this.consume(TokenType.CloseParen, "Expected ')' after if condition.");
    
    const consequent = this.statement();
    let alternate: AST.Statement | null = null;
    if (this.match(TokenType.Else)) {
      alternate = this.statement();
    }

    return { type: "IfStatement", test, consequent, alternate };
  }

  private whileStatement(): AST.WhileStatement {
    this.consume(TokenType.OpenParen, "Expected '(' after 'while'.");
    const test = this.expression();
    this.consume(TokenType.CloseParen, "Expected ')' after while condition.");
    const body = this.statement();

    return { type: "WhileStatement", test, body };
  }

  private forStatement(): AST.ForStatement {
    this.consume(TokenType.OpenParen, "Expected '(' after 'for'.");
    
    let init: AST.Statement | null = null;
    if (!this.match(TokenType.Semicolon)) {
      if (this.isType(this.peek())) {
        const decl = this.declaration();
        if (Array.isArray(decl)) init = { type: "BlockStatement", body: decl };
        else init = decl as AST.Statement;
      } else {
        init = this.expressionStatement();
      }
    }

    let test: AST.Expression | null = null;
    if (!this.check(TokenType.Semicolon)) {
      test = this.expression();
    }
    this.consume(TokenType.Semicolon, "Expected ';' after loop condition.");

    let update: AST.Expression | null = null;
    if (!this.check(TokenType.CloseParen)) {
      update = this.expression();
    }
    this.consume(TokenType.CloseParen, "Expected ')' after for clauses.");

    const body = this.statement();
    return { type: "ForStatement", init, test, update, body };
  }

  private switchStatement(): AST.SwitchStatement {
    this.consume(TokenType.OpenParen, "Expected '(' after 'switch'.");
    const discriminant = this.expression();
    this.consume(TokenType.CloseParen, "Expected ')' after switch value.");
    this.consume(TokenType.OpenBrace, "Expected '{' before switch body.");

    const cases: AST.SwitchCase[] = [];
    while (!this.check(TokenType.CloseBrace) && !this.isAtEnd()) {
      if (this.match(TokenType.Case)) {
        const test = this.expression();
        let rangeEnd: AST.Expression | null = null;
        if (this.match(TokenType.Ellipsis)) {
           rangeEnd = this.expression();
        }
        this.consume(TokenType.Colon, "Expected ':' after case value.");
        
        const consequent: AST.Statement[] = [];
        while (!this.check(TokenType.Case) && !this.check(TokenType.Default) && !this.check(TokenType.CloseBrace) && !this.isAtEnd()) {
          const decl = this.declaration();
          if (Array.isArray(decl)) consequent.push(...decl);
          else consequent.push(decl as AST.Statement);
        }
        cases.push({ type: "SwitchCase", test, rangeEnd, consequent });
      } else if (this.match(TokenType.Default)) {
        this.consume(TokenType.Colon, "Expected ':' after default.");
        const consequent: AST.Statement[] = [];
        while (!this.check(TokenType.Case) && !this.check(TokenType.Default) && !this.check(TokenType.CloseBrace) && !this.isAtEnd()) {
          const decl = this.declaration();
          if (Array.isArray(decl)) consequent.push(...decl);
          else consequent.push(decl as AST.Statement);
        }
        cases.push({ type: "SwitchCase", test: null, consequent });
      } else {
        throw new Error(`Expected 'case' or 'default' inside switch, got ${this.peek().type} at line ${this.peek().line}`);
      }
    }
    this.consume(TokenType.CloseBrace, "Expected '}' after switch body.");
    return { type: "SwitchStatement", discriminant, cases };
  }

  private returnStatement(): AST.ReturnStatement {
    let value: AST.Expression | null = null;
    if (!this.check(TokenType.Semicolon)) {
      value = this.expression();
    }
    this.consume(TokenType.Semicolon, "Expected ';' after return value.");
    return { type: "ReturnStatement", argument: value };
  }

  private tryStatement(): AST.TryStatement {
    const block = this.blockStatement();
    this.consume(TokenType.Catch, "Expected 'catch' after 'try' block.");
    const handler = this.blockStatement();
    return { type: "TryStatement", block, handler };
  }

  private throwStatement(): AST.ThrowStatement {
    this.consume(TokenType.Semicolon, "Expected ';' after 'throw'.");
    return { type: "ThrowStatement" };
  }



  private blockStatement(): AST.BlockStatement {
    this.consume(TokenType.OpenBrace, "Expected '{' before block.");
    const statements: AST.Statement[] = [];
    while (!this.check(TokenType.CloseBrace) && !this.isAtEnd()) {
      const decl = this.declaration();
      if (Array.isArray(decl)) statements.push(...decl);
      else statements.push(decl as AST.Statement);
    }
    this.consume(TokenType.CloseBrace, "Expected '}' after block.");
    return { type: "BlockStatement", body: statements };
  }

  private expressionStatement(): AST.ExpressionStatement {
    const expr = this.expression();
    
    // HolyC Quirk: If expr is a StringLiteral and we have commas, it's a Print call!
    if (expr.type === "StringLiteral" && this.check(TokenType.Comma)) {
        const args: AST.Expression[] = [expr];
        while (this.match(TokenType.Comma)) {
            args.push(this.expression());
        }
        this.consume(TokenType.Semicolon, "Expected ';' after implicit Print statement.");
        return { type: "ExpressionStatement", expression: { type: "CallExpression", callee: "Print", arguments: args } };
    }
    
    this.consume(TokenType.Semicolon, "Expected ';' after expression.");
    
    // HolyC Quirk: Just a string literal prints it.
    if (expr.type === "StringLiteral") {
        return { type: "ExpressionStatement", expression: { type: "CallExpression", callee: "Print", arguments: [expr] } };
    }
    
    // HolyC Quirk: Bare identifiers are function calls
    if (expr.type === "Identifier") {
        return { type: "ExpressionStatement", expression: { type: "CallExpression", callee: expr.name, arguments: [] } };
    }
    
    return { type: "ExpressionStatement", expression: expr };
  }

  // ==== Expressions (Precedence) ====

  private expression(): AST.Expression {
    return this.assignment();
  }

  private assignment(): AST.Expression {
    const expr = this.ternary();

    if (this.match(TokenType.PlusPlus)) {
      if (expr.type === "Identifier" || expr.type === "UnaryExpression") {
        return { type: "AssignmentExpression", left: expr, operator: "=", right: { type: "BinaryExpression", operator: "+", left: expr, right: { type: "NumberLiteral", value: 1, rawValue: "1" } } };
      }
      throw new Error("Invalid assignment target for ++");
    }
    if (this.match(TokenType.MinusMinus)) {
      if (expr.type === "Identifier" || expr.type === "UnaryExpression") {
        return { type: "AssignmentExpression", left: expr, operator: "=", right: { type: "BinaryExpression", operator: "-", left: expr, right: { type: "NumberLiteral", value: 1, rawValue: "1" } } };
      }
      throw new Error("Invalid assignment target for --");
    }

    if (this.match(
          TokenType.Equals,
          TokenType.PlusEquals, TokenType.MinusEquals,
          TokenType.StarEquals, TokenType.SlashEquals, TokenType.PercentEquals,
          TokenType.ShiftLeftEquals, TokenType.ShiftRightEquals,
          TokenType.CaretEquals
        )) {
      const op = this.previous();
      const value = this.assignment();
      
      if (expr.type === "Identifier" || expr.type === "UnaryExpression" || expr.type === "MemberExpression" || expr.type === "IndexExpression") {
        if (op.type !== TokenType.Equals) {
           // Compound assignment: x op= y  ==>  x = x op y
           const binOps: Partial<Record<TokenType, string>> = {
             [TokenType.PlusEquals]: "+",
             [TokenType.MinusEquals]: "-",
             [TokenType.StarEquals]: "*",
             [TokenType.SlashEquals]: "/",
             [TokenType.PercentEquals]: "%",
             [TokenType.ShiftLeftEquals]: "<<",
             [TokenType.ShiftRightEquals]: ">>",
             [TokenType.CaretEquals]: "^"
           };
           return {
             type: "AssignmentExpression",
             left: expr,
             operator: "=",
             right: { type: "BinaryExpression", operator: binOps[op.type]!, left: expr, right: value }
           };
        }
        return {
          type: "AssignmentExpression",
          left: expr,
          operator: "=",
          right: value
        };
      }
      throw new Error(`Invalid assignment target at line ${op.line}`);
    }

    return expr;
  }

  private ternary(): AST.Expression {
    const test = this.logicalOr();
    if (this.match(TokenType.Question)) {
      const consequent = this.expression();
      this.consume(TokenType.Colon, "Expected ':' in ternary expression.");
      const alternate = this.ternary();
      return { type: "TernaryExpression", test, consequent, alternate };
    }
    return test;
  }

  private parseBinary(next: () => AST.Expression, ...ops: TokenType[]): AST.Expression {
    let expr = next.call(this);
    while (this.match(...ops)) {
      expr = { type: "BinaryExpression", operator: this.previous().value, left: expr, right: next.call(this) };
    }
    return expr;
  }

  private logicalOr(): AST.Expression { return this.parseBinary(this.logicalAnd, TokenType.LogicalOr); }
  private logicalAnd(): AST.Expression { return this.parseBinary(this.bitwiseOr, TokenType.LogicalAnd); }
  private bitwiseOr(): AST.Expression { return this.parseBinary(this.bitwiseXor, TokenType.BitwiseOr); }
  private bitwiseXor(): AST.Expression { return this.parseBinary(this.bitwiseAnd, TokenType.Caret); }
  private bitwiseAnd(): AST.Expression { return this.parseBinary(this.equality, TokenType.Ampersand); }
  private equality(): AST.Expression { return this.parseBinary(this.comparison, TokenType.DoubleEquals, TokenType.NotEquals); }
  private comparison(): AST.Expression { return this.parseBinary(this.bitwiseShift, TokenType.LessThan, TokenType.LessEqual, TokenType.GreaterThan, TokenType.GreaterEqual); }
  private bitwiseShift(): AST.Expression { return this.parseBinary(this.term, TokenType.LeftShift, TokenType.RightShift); }
  private term(): AST.Expression { return this.parseBinary(this.factor, TokenType.Minus, TokenType.Plus); }
  private factor(): AST.Expression { return this.parseBinary(this.unary, TokenType.Slash, TokenType.Star, TokenType.Modulo); }

  private unary(): AST.Expression {
    if (this.match(TokenType.PlusPlus, TokenType.MinusMinus, TokenType.Bang, TokenType.Minus, TokenType.Star, TokenType.Ampersand)) {
      const operator = this.previous().value;
      const right = this.unary();
      
      if (operator === "++" || operator === "--") {
         return {
           type: "UpdateExpression",
           operator,
           argument: right,
           prefix: true
         };
      }
      
      return { type: "UnaryExpression", operator, argument: right };
    }
    return this.call();
  }

  private call(): AST.Expression {
    let expr = this.primary();

    while (true) {
      if (this.match(TokenType.OpenParen)) {
        expr = this.finishCall(expr);
      } else if (this.match(TokenType.Dot, TokenType.Arrow)) {
        const isArrow = this.previous().type === TokenType.Arrow;
        const property = this.consume(TokenType.Identifier, `Expected property name after '${isArrow ? "->" : "."}'.`);
        expr = { type: "MemberExpression", object: expr, property: property.value, isArrow };
      } else if (this.match(TokenType.OpenBracket)) {
        const index = this.expression();
        this.consume(TokenType.CloseBracket, "Expected ']' after index.");
        expr = { type: "IndexExpression", object: expr, index };
      } else if (this.match(TokenType.PlusPlus, TokenType.MinusMinus)) {
        const operator = this.previous().value as "++" | "--";
        expr = { type: "UpdateExpression", operator, argument: expr, prefix: false };
      } else {
        break;
      }
    }

    return expr;
  }

  private finishCall(callee: AST.Expression): AST.Expression {
    const args: AST.Expression[] = [];
    if (!this.check(TokenType.CloseParen)) {
      do {
        args.push(this.expression());
      } while (this.match(TokenType.Comma));
    }
    this.consume(TokenType.CloseParen, "Expected ')' after arguments.");
    
    let calleeVal: AST.Expression | string = callee;
    if (callee.type === "Identifier") {
        calleeVal = callee.name;
    }

    return {
      type: "CallExpression",
      callee: calleeVal,
      arguments: args
    };
  }

  private primary(): AST.Expression {
    if (this.match(TokenType.OpenBrace)) {
      const elements: AST.Expression[] = [];
      if (!this.check(TokenType.CloseBrace)) {
        do {
          elements.push(this.expression());
        } while (this.match(TokenType.Comma));
      }
      this.consume(TokenType.CloseBrace, "Expected '}' after array literal.");
      return { type: "ArrayLiteral", elements };
    }

    if (this.match(TokenType.Number)) {
      const raw = this.previous().value;
      return { type: "NumberLiteral", value: Number(raw), rawValue: raw };
    }

    if (this.match(TokenType.String)) {
      return { type: "StringLiteral", value: this.previous().value };
    }

    if (this.match(TokenType.Identifier, TokenType.U0, TokenType.I64, TokenType.U64, TokenType.F64, TokenType.I32, TokenType.U32, TokenType.I16, TokenType.U16, TokenType.I8, TokenType.U8)) {
          return { type: "Identifier", name: this.previous().value };
        }


    if (this.match(TokenType.OpenParen)) {
      const expr = this.expression();
      this.consume(TokenType.CloseParen, "Expected ')' after expression.");
      return expr;
    }

    if (this.match(TokenType.HashExe)) {
      this.consume(TokenType.OpenBrace, "Expected '{' after #exe");
      let bodyText = "";
      while (!this.check(TokenType.CloseBrace) && !this.isAtEnd()) {
        const tok = this.advance();
        if (tok.type === TokenType.String) bodyText += '"' + tok.value.replace(/\n/g, "\\n") + '" ';
        else bodyText += tok.value + " ";
      }
      this.consume(TokenType.CloseBrace, "Expected '}' after #exe block");
      // Sandboxed evaluation (no arbitrary JS).
      const exe = new ExeEvaluator();
      try {
        const ev = exe.evaluate(bodyText);
        if (exe.result === undefined && typeof ev === "string") console.log(ev);
      } catch (e) { console.error("Error evaluating #exe:", e); }
      if (exe.result !== undefined) {
        if (typeof exe.result === "number") return { type: "NumberLiteral", value: exe.result, rawValue: exe.result.toString() };
        if (typeof exe.result === "string") return { type: "StringLiteral", value: exe.result };
      }
      return { type: "NumberLiteral", value: 0, rawValue: "0" };
    }

    throw new Error(`Expected expression at line ${this.peek().line}, col ${this.peek().column}, got ${this.peek().type}`);
  }
}
