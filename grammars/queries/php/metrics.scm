; Code health metrics for PHP: see src/analysis/metrics/measure.ts.

; Functions bound to a name (not abstract methods), and anonymous ones.
(function_definition name: (_) @name) @function
(method_declaration name: (_) @name body: (_)) @function
(assignment_expression left: (variable_name) @name right: [(anonymous_function) (arrow_function)] @function)
[(anonymous_function) (arrow_function)] @lambda
[(function_call_expression function: (_) @name arguments: (arguments (argument [(anonymous_function) (arrow_function)] @lambda)))
 (scoped_call_expression name: (_) @name arguments: (arguments (argument [(anonymous_function) (arrow_function)] @lambda)))
 (member_call_expression name: (_) @name arguments: (arguments (argument [(anonymous_function) (arrow_function)] @lambda)))]
[(class_declaration name: (_) @name) (trait_declaration name: (_) @name)
 (interface_declaration name: (_) @name) (enum_declaration name: (_) @name)] @scope

; Decision points.
[(if_statement) (else_if_clause) (for_statement) (foreach_statement) (while_statement)
 (do_statement) (case_statement) (match_conditional_expression) (catch_clause)
 (conditional_expression)] @branch
(binary_expression operator: ["&&" "||" "and" "or"]) @branch

; Nesting, with `else if` chains kept flat (`elseif` is a clause of its `if`).
[(if_statement) (for_statement) (foreach_statement) (while_statement) (do_statement)
 (switch_statement) (match_expression) (try_statement)] @nesting
(else_clause body: (if_statement) @else_if)

; Parameters.
(formal_parameters [(simple_parameter) (variadic_parameter) (property_promotion_parameter)] @parameter)

(comment) @comment
