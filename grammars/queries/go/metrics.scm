; Code health metrics for Go: see src/analysis/metrics/measure.ts.

; Functions bound to a name (methods qualified by their receiver type), and anonymous ones.
(function_declaration name: (_) @name) @function
(method_declaration name: (_) @name) @function
(method_declaration
  receiver: (parameter_list (parameter_declaration type: [
    (type_identifier) @receiver
    (pointer_type (type_identifier) @receiver)
    (generic_type type: (type_identifier) @receiver)
    (pointer_type (generic_type type: (type_identifier) @receiver))]))
  name: (_) @name) @function
(short_var_declaration left: (expression_list . (identifier) @name) right: (expression_list . (func_literal) @function))
(var_spec name: (identifier) @name value: (expression_list . (func_literal) @function))
(func_literal) @lambda

; Decision points: Go has no ternary and no catch.
[(if_statement) (for_statement) (expression_case) (type_case) (communication_case)] @branch
(binary_expression operator: ["&&" "||"]) @branch

; Nesting, with else-if chains kept flat.
[(if_statement) (for_statement) (expression_switch_statement) (type_switch_statement)
 (select_statement)] @nesting
(if_statement alternative: (if_statement) @else_if)

; Parameters: every declared name (`a, b int` is two), not the receiver.
([(function_declaration parameters: (parameter_list (parameter_declaration name: (identifier) @parameter)))
  (method_declaration parameters: (parameter_list (parameter_declaration name: (identifier) @parameter)))
  (func_literal parameters: (parameter_list (parameter_declaration name: (identifier) @parameter)))])
[(function_declaration parameters: (parameter_list [(parameter_declaration !name) (variadic_parameter_declaration)] @parameter))
 (method_declaration parameters: (parameter_list [(parameter_declaration !name) (variadic_parameter_declaration)] @parameter))
 (func_literal parameters: (parameter_list [(parameter_declaration !name) (variadic_parameter_declaration)] @parameter))]

(comment) @comment
