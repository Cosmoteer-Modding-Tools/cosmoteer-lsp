# Changelog

All notable changes to this project will be documented in this file.

# Version 0.3.1 Beta Hotfix

-   Notify the user that when he doesn't see the settings, that he needs to restart vscode.

# Version 0.3.0 Beta

-   Removed InheritanceNode and replaced it with a property in the ObjectNode and ArrayNode
-   Added Readme for Images Folder
-   Added setting for Cosmoteer Workspace and show error message when not set
-   Added validation for references which are not assets
-   Added validation for Assignments `=` where the right side is a reference
-   Added validation for Values which are paranthesized
-   Added validation for Math expressions
-   Added a new icon for the Extension
-   Fixed a bug with `""` String which used `<` at the beginning but wasn't a reference, would be regocnized as a reference.
-   Fixed a bug which would lead to parse a document 3 times in a row
-   Fixed a bug with `,` which is like `;` a seperator in Objects
-   Fixed a bug with `\` where it would crash the language server when its not after a string
-   Fixed some bugs with the parser and autocompletion which would crash the language server
-   Fixed a bug with `Values` in function calls which would have a start position where the function begins instead of the string, which would lead to a confusing error highlighting
-   Fixed a bug with Math expressions which were not recognized as a valid node.
-   Fixed some of styling issues with the grammar. References should now hopefully be all highlighted in the same color and numbers should be more consistent too.

# Version 0.2.1 Beta Hotfix

-   Fixed a Bug with `&` in function calls validation that they need to be paranthesized, even if they don't need to be
-   Fixed a bug with `/` in tokenization which would be regocnized as a string path instead of a expresson when a number is before it
-   Fixed a bug with `""` empty strings, beeing regocnized as undefined in the parser and crashed the language server
-   Added String delimiters `\` to the parser to prevent crashes and better error handling for that
-   Added types for Value Nodes for better type checking

# Version 0.1.0 Beta

-   Added support for `&` references in the same parent scope
-       Added validation for references in the same parent scope (e.g. `{}`)
-   Added validation for function calls
-   Added localisation support (en, de) so far
-   Fixed Bug with ';' after Arrays
-   Fixed Bug with ';' as seperator in Objects
-   Fixed Bug with function call first parameter parantheses
-   Added a File Icon for `.rules` files for dark and light themes
-   Added icon for extension
-   Added detailed diagnostics for errors

# Version 0.0.1 Beta

-   Initial Beta release
-   Added basic semantic highlighting and diagnostics
