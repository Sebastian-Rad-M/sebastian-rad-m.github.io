export type Type = "U0" | "U8" | "I8" | "I64" | "U64" | "F64" | "I32" | "U32" | "I16" | "U16" | "CTask"; // HolyC Types

export interface Program {
  type: "Program";
  body: Statement[];
}

export type Statement =
  | VariableDeclaration
  | FunctionDeclaration
  | ClassDeclaration
  | ReturnStatement
  | ExpressionStatement
  | IfStatement
  | WhileStatement
  | ForStatement
  | SwitchStatement
  | BreakStatement
  | ContinueStatement
  | TryStatement
  | ThrowStatement
  | BlockStatement;

export interface FunctionDeclaration {
  type: "FunctionDeclaration";
  returnType: Type;
  name: string;
  params: Parameter[];
  body: BlockStatement;
  isVararg?: boolean;
}

export interface ClassDeclaration {
  type: "ClassDeclaration";
  name: string;
  members: VariableDeclaration[];
  isUnion?: boolean;
}

export interface Parameter {
  varType: Type;
  name: string;
  pointerDepth: number;
  defaultValue?: Expression | null;
}

export interface VariableDeclaration {
  type: "VariableDeclaration";
  varType: Type;
  name: string;
  initializer: Expression | null;
  pointerDepth: number;
  arraySize?: Expression;
}

export interface BlockStatement {
  type: "BlockStatement";
  body: Statement[];
}

export interface ExpressionStatement {
  type: "ExpressionStatement";
  expression: Expression;
}

export interface ReturnStatement {
  type: "ReturnStatement";
  argument: Expression | null;
}

export interface IfStatement {
  type: "IfStatement";
  test: Expression;
  consequent: Statement;
  alternate: Statement | null;
}

export interface WhileStatement {
  type: "WhileStatement";
  test: Expression;
  body: Statement;
}

export interface ForStatement {
  type: "ForStatement";
  init: Statement | null;
  test: Expression | null;
  update: Expression | null;
  body: Statement;
}

export interface BreakStatement {
  type: "BreakStatement";
}

export interface ContinueStatement {
  type: "ContinueStatement";
}

export interface SwitchCase {
  type: "SwitchCase";
  test: Expression | null; // null = default
  rangeEnd?: Expression | null; // 1...5
  consequent: Statement[];
}

export interface SwitchStatement {
  type: "SwitchStatement";
  discriminant: Expression;
  cases: SwitchCase[];
}

export interface TryStatement {
  type: "TryStatement";
  block: BlockStatement;
  handler: BlockStatement;
}

export interface ThrowStatement {
  type: "ThrowStatement";
}

export interface ArrayLiteral {
  type: "ArrayLiteral";
  elements: Expression[];
}

export type Expression =
  | BinaryExpression
  | UnaryExpression
  | NumberLiteral
  | StringLiteral
  | Identifier
  | CallExpression
  | AssignmentExpression
  | MemberExpression
  | IndexExpression
  | ArrayLiteral
  | UpdateExpression
  | TernaryExpression;

export interface UpdateExpression {
  type: "UpdateExpression";
  operator: "++" | "--";
  argument: Expression;
  prefix: boolean;
}

export interface TernaryExpression {
  type: "TernaryExpression";
  test: Expression;
  consequent: Expression;
  alternate: Expression;
}

export interface MemberExpression {
  type: "MemberExpression";
  object: Expression;
  property: string;
  isArrow?: boolean;
}

export interface IndexExpression {
  type: "IndexExpression";
  object: Expression;
  index: Expression;
}

export interface BinaryExpression {
  type: "BinaryExpression";
  operator: string;
  left: Expression;
  right: Expression;
}

export interface UnaryExpression {
  type: "UnaryExpression";
  operator: string;
  argument: Expression;
}

export interface AssignmentExpression {
  type: "AssignmentExpression";
  left: Expression; 
  operator: string; //Christ-like to use "="
  right: Expression;
}

export interface CallExpression {
  type: "CallExpression";
  callee: Expression | string;
  arguments: Expression[];
}

export interface NumberLiteral {
  type: "NumberLiteral";
  value: number;
  rawValue: string;
}

export interface StringLiteral {
  type: "StringLiteral";
  value: string;
  rawValue?: string;
}

export interface Identifier {
  type: "Identifier";
  name: string;
}
