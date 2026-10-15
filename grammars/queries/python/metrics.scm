; Code health metrics for Python: see src/analysis/metrics/measure.ts.

; Functions bound to a name, and anonymous ones.
(function_definition name: (_) @name) @function
(assignment left: (identifier) @name right: (lambda) @function)
(lambda) @lambda
(class_definition name: (_) @name) @scope

; Decision points. A wildcard `case _:` is the default arm, like `default:` elsewhere.
; Comprehension clauses do not count, as `filter()` and `map()` calls do not.
[(if_statement) (elif_clause) (for_statement) (while_statement) (except_clause)
 (conditional_expression) (boolean_operator)] @branch
(case_clause (case_pattern (_))) @branch

; Nesting.
[(if_statement) (for_statement) (while_statement) (match_statement) (try_statement)
 (with_statement)] @nesting

; Parameters, without the receiver of methods.
(parameters [(identifier) (typed_parameter) (default_parameter) (typed_default_parameter)
 (list_splat_pattern) (dictionary_splat_pattern)] @parameter
 (#not-any-of? @parameter "self" "cls"))
(lambda_parameters [(identifier) (default_parameter) (list_splat_pattern) (dictionary_splat_pattern)] @parameter)

; Comments and docstrings.
(comment) @comment
(module . (expression_statement (string) @comment))
(function_definition body: (block . (expression_statement (string) @comment)))
(class_definition body: (block . (expression_statement (string) @comment)))
