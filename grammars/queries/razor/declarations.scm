(class_declaration name: (identifier) @name) @declaration.class
(interface_declaration name: (identifier) @name) @declaration.interface
(struct_declaration name: (identifier) @name) @declaration.struct
(enum_declaration name: (identifier) @name) @declaration.enum
(record_declaration name: (identifier) @name) @declaration.record
(delegate_declaration name: (identifier) @name) @declaration.type
(method_declaration name: (identifier) @name) @declaration.method
(constructor_declaration name: (identifier) @name) @declaration.constructor
(property_declaration name: (identifier) @name) @declaration.property
(variable_declaration (variable_declarator name: (identifier) @name)) @declaration.field
(local_function_statement name: (identifier) @name) @declaration.function
(enum_member_declaration name: (identifier) @name) @declaration.enum-case
(event_declaration name: (identifier) @name) @declaration.event
(destructor_declaration name: (identifier) @name) @declaration.destructor
(indexer_declaration "this" @name) @declaration.indexer
(operator_declaration operator: _ @name) @declaration.operator
(razor_addtaghelper_directive) @region
(razor_attribute_directive) @region
(razor_block) @region
(razor_catch) @region
(razor_comment) @region
(razor_compound_using) @region
(razor_do_while) @region
(razor_else) @region
(razor_else_if) @region
(razor_escape) @region
(razor_explicit_expression) @region
(razor_finally) @region
(razor_for) @region
(razor_foreach) @region
(razor_html_attribute) @region
(razor_if) @region
(razor_implements_directive) @region
(razor_implicit_expression) @region
(razor_inherits_directive) @region
(razor_inject_directive) @region
(razor_layout_directive) @region
(razor_lock) @region
(razor_model_directive) @region
(razor_namespace_directive) @region
(razor_page_directive) @region
(razor_preservewhitespace_directive) @region
(razor_removetaghelper_directive) @region
(razor_rendermode_directive) @region
(razor_section) @region
(razor_switch) @region
(razor_taghelperprefix_directive) @region
(razor_try) @region
(razor_typeparam_directive) @region
(razor_using_directive) @region
(razor_while) @region
(explicit_line_transition) @region
(element) @markup
(html_comment) @opaque
[(preproc_if) (preproc_else) (preproc_elif) (preproc_define) (preproc_undef) (preproc_region) (preproc_endregion) (preproc_nullable)] @preprocessor
