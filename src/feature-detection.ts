import { types as t, type NodePath } from "@babel/core";

// Returns true if `path` is only checking whether the built-in exists, or
// defining it: for example `typeof structuredClone`, `if (Object.hasOwn)`,
// `Object.hasOwn?.(a, b)` or `Object.hasOwn = function () {}`.
export function isFeatureDetection(path: NodePath): boolean {
  const { node, parent, parentPath } = path;

  if (t.isUnaryExpression(parent)) {
    return ["typeof", "delete", "!"].includes(parent.operator);
  }
  if (
    parentPath.isAssignmentExpression({ left: node }) ||
    parentPath.isUpdateExpression()
  ) {
    return true;
  }
  if (
    (parentPath.isOptionalCallExpression({ callee: node }) &&
      (parent as t.OptionalCallExpression).optional) ||
    (parentPath.isOptionalMemberExpression({ object: node }) &&
      (parent as t.OptionalMemberExpression).optional)
  ) {
    return true;
  }
  if (t.isBinaryExpression(parent) && isNullishComparison(parent, node)) {
    return true;
  }

  return isInTestPosition(path);
}

// Returns true if the value of `path` is only used as a condition.
function isInTestPosition(path: NodePath): boolean {
  const { node, parent, parentPath } = path;

  if (t.isLogicalExpression(parent)) {
    // `X && ...`, `X || ...` and `X ?? ...` check if X exists.
    if (parent.left === node) return true;
    return isInTestPosition(parentPath);
  }
  if (
    parentPath.isIfStatement({ test: node }) ||
    parentPath.isConditionalExpression({ test: node }) ||
    parentPath.isWhileStatement({ test: node }) ||
    parentPath.isDoWhileStatement({ test: node }) ||
    parentPath.isForStatement({ test: node })
  ) {
    return true;
  }
  return false;
}

// X == null, X !== undefined, X === void 0, ...
function isNullishComparison(binary: t.BinaryExpression, node: t.Node) {
  if (!["==", "!=", "===", "!=="].includes(binary.operator)) return false;
  const other = binary.left === node ? binary.right : binary.left;
  return (
    t.isNullLiteral(other) ||
    t.isIdentifier(other, { name: "undefined" }) ||
    t.isUnaryExpression(other, { operator: "void" })
  );
}

// Returns true if `path` is only evaluated after checking that the built-in
// exists: for example `Object.hasOwn && Object.hasOwn(a, b)`,
// `if (typeof structuredClone === "function") structuredClone(x)` or
// `"findLast" in arr ? arr.findLast(fn) : fallback(arr, fn)`.
export function isGuarded(path: NodePath): boolean {
  const { node } = path;

  let child: NodePath = path;
  for (let parent = path.parentPath; parent; parent = parent.parentPath) {
    let test: t.Node | null = null;
    if (parent.isLogicalExpression({ operator: "&&", right: child.node })) {
      test = parent.node.left;
    } else if (
      (parent.isIfStatement() || parent.isConditionalExpression()) &&
      child.node === parent.node.consequent
    ) {
      test = parent.node.test;
    }

    if (test && getConditions(test).some(c => checksExistence(c, node))) {
      return true;
    }

    if (parent.isFunction() || parent.isProgram()) return false;
    child = parent;
  }
  return false;
}

// Split `a && b && c` into `[a, b, c]`
function getConditions(test: t.Node): t.Node[] {
  if (t.isLogicalExpression(test, { operator: "&&" })) {
    return [...getConditions(test.left), ...getConditions(test.right)];
  }
  return [test];
}

// Returns true if `condition` is only truthy when `node` exists.
function checksExistence(condition: t.Node, node: t.Node): boolean {
  if (equivalent(condition, node)) return true;

  if (t.isUnaryExpression(condition, { operator: "!" })) {
    // !!X
    return (
      t.isUnaryExpression(condition.argument, { operator: "!" }) &&
      equivalent(condition.argument.argument, node)
    );
  }

  if (t.isBinaryExpression(condition)) {
    const { left, right, operator } = condition;

    // typeof X === "function", typeof X !== "undefined"
    if (["==", "===", "!=", "!=="].includes(operator)) {
      for (const [a, b] of [
        [left, right],
        [right, left],
      ]) {
        if (
          t.isUnaryExpression(a, { operator: "typeof" }) &&
          equivalent(a.argument, node) &&
          t.isStringLiteral(b)
        ) {
          const negated = operator === "!=" || operator === "!==";
          return negated === (b.value === "undefined");
        }
      }
      // X != null, X !== undefined
      if (operator === "!=" || operator === "!==") {
        return (
          (equivalent(left, node) && isNullishComparison(condition, left)) ||
          (equivalent(right, node) && isNullishComparison(condition, right))
        );
      }
    }

    // "key" in obj, for obj.key
    if (
      operator === "in" &&
      t.isStringLiteral(left) &&
      isStaticMember(node, left.value) &&
      equivalent(right, node.object)
    ) {
      return true;
    }
  }

  return false;
}

function isStaticMember(
  node: t.Node,
  key: string,
): node is t.MemberExpression | t.OptionalMemberExpression {
  return (
    (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
    !node.computed &&
    t.isIdentifier(node.property, { name: key })
  );
}

// t.isNodesEquivalent narrows the type of its second argument, which is not
// what we want when checking against multiple conditions.
function equivalent(a: t.Node, b: t.Node): boolean {
  return t.isNodesEquivalent(a, b);
}
