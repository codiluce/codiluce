(class_declaration name: (identifier) @name) @declaration.class
(interface_declaration name: (identifier) @name) @declaration.interface
(enum_declaration name: (identifier) @name) @declaration.enum
(record_declaration name: (identifier) @name) @declaration.record
(annotation_type_declaration name: (identifier) @name) @declaration.annotation
(method_declaration name: (identifier) @name) @declaration.method
(constructor_declaration name: (identifier) @name) @declaration.constructor
(compact_constructor_declaration name: (identifier) @name) @declaration.constructor
(field_declaration declarator: (variable_declarator name: (identifier) @name) @declaration.property)
(constant_declaration declarator: (variable_declarator name: (identifier) @name) @declaration.property)
(enum_constant name: (identifier) @name) @declaration.property
