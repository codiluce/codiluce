(namespace_declaration name: (_) @name) @declaration.namespace
(class_declaration name: (identifier) @name) @declaration.class
(interface_declaration name: (identifier) @name) @declaration.interface
(struct_declaration name: (identifier) @name) @declaration.struct
(enum_declaration name: (identifier) @name) @declaration.enum
(record_declaration name: (identifier) @name) @declaration.record
(delegate_declaration name: (identifier) @name) @declaration.type
(method_declaration name: (identifier) @name) @declaration.method
(constructor_declaration name: (identifier) @name) @declaration.constructor
(property_declaration name: (identifier) @name) @declaration.property
(field_declaration (variable_declaration (variable_declarator name: (identifier) @name) @declaration.property))
