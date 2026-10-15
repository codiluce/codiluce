; Code health metrics for TypeScript and TSX: see src/analysis/metrics/measure.ts.

; Functions bound to a name, and anonymous ones.
(function_declaration name: (_) @name) @function
(generator_function_declaration name: (_) @name) @function
(method_definition name: (_) @name) @function
(function_expression name: (_) @name) @function
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)] @function)
(variable_declarator name: (identifier) @name value: (call_expression arguments: (arguments . [(arrow_function) (function_expression)] @function)))
(public_field_definition name: (_) @name value: [(arrow_function) (function_expression)] @function)
(pair key: (_) @name value: [(arrow_function) (function_expression) (generator_function)] @function)
(assignment_expression left: (_) @name right: [(arrow_function) (function_expression) (generator_function)] @function)
[(arrow_function) (function_expression) (generator_function)] @lambda
(call_expression function: (_) @name arguments: (arguments [(arrow_function) (function_expression)] @lambda))
[(class_declaration name: (_) @name) (abstract_class_declaration name: (_) @name) (class name: (_) @name)] @scope

; Decision points.
[(if_statement) (for_statement) (for_in_statement) (while_statement) (do_statement)
 (switch_case) (catch_clause) (ternary_expression)] @branch
(binary_expression operator: ["&&" "||"]) @branch

; Nesting, with else-if chains kept flat.
[(if_statement) (for_statement) (for_in_statement) (while_statement) (do_statement)
 (switch_statement) (try_statement)] @nesting
(else_clause (if_statement) @else_if)

; Parameters.
(formal_parameters [(required_parameter) (optional_parameter)] @parameter)
(arrow_function parameter: (_) @parameter)

(comment) @comment
