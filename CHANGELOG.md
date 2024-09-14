# Changelog

All notable changes to this project will be documented in this file.

# Version 0.2.1 Beta Hotfix
-   Fixed a Bug with `&` in function calls validation that they need to be paranthesized, even if they don't need to be
-   Fixed a bug with `/` in tokenization which would be regocnized as a string path instead of a expresson when a number is before it
-   Fixed a bug with `""` empty strings, beeing regocnized as undefined in the parser and crashed the language server
-   Added String delimiters `\` to the parser to prevent crashes and better error handling for that
-   Added types for Value Nodes for better type checking

# Version 0.1.0 Beta
-   Added support for `&` references in the same parent scope
-  	Added validation for references in the same parent scope (e.g. `{}`)
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
