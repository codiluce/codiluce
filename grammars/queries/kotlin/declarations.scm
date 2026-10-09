(class_declaration name: (identifier) @name) @declaration.class
(object_declaration name: (identifier) @name) @declaration.object
(function_declaration name: (identifier) @name) @declaration.function
(type_alias type: (identifier) @name) @declaration.typealias
(property_declaration (variable_declaration (identifier) @name)) @declaration.property
