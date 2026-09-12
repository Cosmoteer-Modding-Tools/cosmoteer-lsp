import { l10n } from 'vscode';

/**
 * The user-visible text of the two bundled webview scripts. A webview script runs sandboxed in the
 * page and cannot reach the l10n API, so the panels look every string up here and inline the result
 * into the page ahead of the script. Each string is keyed by its English source the same way the
 * l10n bundle is, so a page whose host inlines no bundle still shows the English words.
 */

/**
 * The text the part grid editor page shows.
 *
 * @returns every string the page looks up, keyed by its English source.
 */
export const partGridEditorStrings = (): Record<string, string> => ({
    View: l10n.t('View'),
    '↶ Undo': l10n.t('↶ Undo'),
    'Undo the last grid edit (Ctrl+Z)': l10n.t('Undo the last grid edit (Ctrl+Z)'),
    '↷ Redo': l10n.t('↷ Redo'),
    'Redo the last undone grid edit (Ctrl+Y)': l10n.t('Redo the last undone grid edit (Ctrl+Y)'),
    'Rotate view counter-clockwise': l10n.t('Rotate view counter-clockwise'),
    'Rotate view clockwise': l10n.t('Rotate view clockwise'),
    'Flip view horizontally': l10n.t('Flip view horizontally'),
    'Flip view vertically': l10n.t('Flip view vertically'),
    'Zoom out': l10n.t('Zoom out'),
    'Zoom in': l10n.t('Zoom in'),
    'rotation {0}°{1} (view only, coordinates stay rotation-0)': l10n.t(
        'rotation {0}°{1} (view only, coordinates stay rotation-0)'
    ),
    Size: l10n.t('Size'),
    'W−': l10n.t('W−'),
    'Shrink width': l10n.t('Shrink width'),
    'W+': l10n.t('W+'),
    'Grow width': l10n.t('Grow width'),
    'H−': l10n.t('H−'),
    'Shrink height': l10n.t('Shrink height'),
    'H+': l10n.t('H+'),
    'Grow height': l10n.t('Grow height'),
    'Resizing does not move existing cell entries.': l10n.t('Resizing does not move existing cell entries.'),
    Sprites: l10n.t('Sprites'),
    '{0} (missing)': l10n.t('{0} (missing)'),
    'No sprites resolved.': l10n.t('No sprites resolved.'),
    Layers: l10n.t('Layers'),
    'Edit this layer': l10n.t('Edit this layer'),
    'Show this layer': l10n.t('Show this layer'),
    inherited: l10n.t('inherited'),
    'Defined on a base part. Editing creates a local override.': l10n.t(
        'Defined on a base part. Editing creates a local override.'
    ),
    'Go to source': l10n.t('Go to source'),
    'Each strip is a door opening in the wall toward that cell. A dashed cell is not adjacent to the physical rect and never matches a door.':
        l10n.t(
            'Each strip is a door opening in the wall toward that cell. A dashed cell is not adjacent to the physical rect and never matches a door.'
        ),
    'Cells inside the part.': l10n.t('Cells inside the part.'),
    'Click a cell to toggle it. {0}': l10n.t('Click a cell to toggle it. {0}'),
    'Click near a cell edge/corner to toggle that wall. Right-click clears the cell.': l10n.t(
        'Click near a cell edge/corner to toggle that wall. Right-click clears the cell.'
    ),
    'Select a cell, then toggle directions below. Right-click clears the cell.': l10n.t(
        'Select a cell, then toggle directions below. Right-click clears the cell.'
    ),
    'Whole-part fallback: {0}': l10n.t('Whole-part fallback: {0}'),
    'Cell [{0}, {1}]': l10n.t('Cell [{0}, {1}]'),
    'Set {0}': l10n.t('Set {0}'),
    Clear: l10n.t('Clear'),
    'Remove this cell entry': l10n.t('Remove this cell entry'),
    'Drag a point to move it. This list has a fixed length.': l10n.t(
        'Drag a point to move it. This list has a fixed length.'
    ),
    'Click to place a point, drag to move it, right-click to remove.': l10n.t(
        'Click to place a point, drag to move it, right-click to remove.'
    ),
    'Click the external cell, then the internal cell. Right-click a pair to remove it.': l10n.t(
        'Click the external cell, then the internal cell. Right-click a pair to remove it.'
    ),
    'Drag the corner handles to resize.': l10n.t('Drag the corner handles to resize.'),
    '{0} is hidden. Tick its checkbox to edit it.': l10n.t('{0} is hidden. Tick its checkbox to edit it.'),
    'Fit the part in the panel': l10n.t('Fit the part in the panel'),
    'Drag the corner handles to resize. This rect is written from references, so the numbers are written where they are declared.':
        l10n.t(
            'Drag the corner handles to resize. This rect is written from references, so the numbers are written where they are declared.'
        ),
    Create: l10n.t('Create'),
    'Create the rect covering the part': l10n.t('Create the rect covering the part'),
    Remove: l10n.t('Remove'),
    'Remove the local rect field': l10n.t('Remove the local rect field'),
    'Click to place the point, drag to move, right-click to remove.': l10n.t(
        'Click to place the point, drag to move, right-click to remove.'
    ),
    'Click a cell to set it, right-click to remove the field.': l10n.t(
        'Click a cell to set it, right-click to remove the field.'
    ),
    'Click a cell to move it. Click an edge of the current cell (or a button) to face it.': l10n.t(
        'Click a cell to move it. Click an edge of the current cell (or a button) to face it.'
    ),
    'Face {0}': l10n.t('Face {0}'),
    Set: l10n.t('Set'),
    'Write MaxTiles': l10n.t('Write MaxTiles'),
    'MaxTiles: a positive integer': l10n.t('MaxTiles: a positive integer'),
    'Drag a vertex to move it. Click an edge to insert a vertex there, elsewhere to append one. Right-click removes a vertex.':
        l10n.t(
            'Drag a vertex to move it. Click an edge to insert a vertex there, elsewhere to append one. Right-click removes a vertex.'
        ),
    'Click to place the center, drag the ring handle to change the radius.': l10n.t(
        'Click to place the center, drag the ring handle to change the radius.'
    ),
    'Drag the ring handle to change the radius. The center follows the component location.': l10n.t(
        'Drag the ring handle to change the radius. The center follows the component location.'
    ),
    'The center follows the component. Move it in the Component locations layer.': l10n.t(
        'The center follows the component. Move it in the Component locations layer.'
    ),
    'Drag the halo boundary to change how many cells the region reaches beyond the part. Right-click clears the distance.':
        l10n.t(
            'Drag the halo boundary to change how many cells the region reaches beyond the part. Right-click clears the distance.'
        ),
    'Distance:': l10n.t('Distance:'),
    'Write the region distance': l10n.t('Write the region distance'),
    'Distance: a non-negative integer': l10n.t('Distance: a non-negative integer'),
    'Drag a corner handle to resize a rect, right-click one to remove it.': l10n.t(
        'Drag a corner handle to resize a rect, right-click one to remove it.'
    ),
    'category (e.g. tall)': l10n.t('category (e.g. tall)'),
    'Add rect': l10n.t('Add rect'),
    'Append a rect above the part': l10n.t('Append a rect above the part'),
    'Scalar fields also prohibit: {0} (dashed).': l10n.t('Scalar fields also prohibit: {0} (dashed).'),
    'Click a marker to select (clicking a stack cycles through it), drag to move. Grey markers are chained or reference-valued.':
        l10n.t(
            'Click a marker to select (clicking a stack cycles through it), drag to move. Grey markers are chained or reference-valued.'
        ),
    '{0} components (click to cycle)': l10n.t('{0} components (click to cycle)'),
    'no location': l10n.t('no location'),
    ref: l10n.t('ref'),
    'Chained to {0}. Dragging edits its local offset.': l10n.t('Chained to {0}. Dragging edits its local offset.'),
    'This location is written from references, so the numbers are written where they are declared.': l10n.t(
        'This location is written from references, so the numbers are written where they are declared.'
    ),
    'Rotation:': l10n.t('Rotation:'),
    'Write the rotation in degrees': l10n.t('Write the rotation in degrees'),
    'Rotation: a number in degrees': l10n.t('Rotation: a number in degrees'),
    'Rotate to {0} degrees': l10n.t('Rotate to {0} degrees'),
    'Snap:': l10n.t('Snap:'),
    free: l10n.t('free'),
    'Snap to {0} cells': l10n.t('Snap to {0} cells'),
    'Rotation & flipping': l10n.t('Rotation & flipping'),
    'e.g. 0, 2, 1, 3': l10n.t('e.g. 0, 2, 1, 3'),
    'Write {0}': l10n.t('Write {0}'),
    '{0}: only integers': l10n.t('{0}: only integers'),
    'Use the view rotation above to preview how rotations will look.': l10n.t(
        'Use the view rotation above to preview how rotations will look.'
    ),
    'Toggling writes the field.': l10n.t('Toggling writes the field.'),
    'Unset, the game defaults to Sides.': l10n.t('Unset, the game defaults to Sides.'),
    Unset: l10n.t('Unset'),
    'Remove the local field': l10n.t('Remove the local field'),
    'Virtual cell: now click the internal cell (right-click cancels)': l10n.t(
        'Virtual cell: now click the internal cell (right-click cancels)'
    ),
    'cell [{0}]  ·  [{1}]': l10n.t('cell [{0}]  ·  [{1}]'),
    'No part found at this position.': l10n.t('No part found at this position.'),
    'Edit rejected ({0}). Resyncing…': l10n.t('Edit rejected ({0}). Resyncing…'),
});

/**
 * The text the shader preview page shows.
 *
 * @returns every string the page looks up, keyed by its English source.
 */
export const shaderPreviewStrings = (): Record<string, string> => ({
    'Vertex color (anim)': l10n.t('Vertex color (anim)'),
    'Vertex color': l10n.t('Vertex color'),
    'The particle system animates this colour over each particle’s lifetime (ColorRamp). Uncheck anim to hold a colour.':
        l10n.t(
            'The particle system animates this colour over each particle’s lifetime (ColorRamp). Uncheck anim to hold a colour.'
        ),
    'A particle drives its effect with per-vertex colour. Red sweeps the animation, alpha is brightness.': l10n.t(
        'A particle drives its effect with per-vertex colour. Red sweeps the animation, alpha is brightness.'
    ),
    'The material vertex-colour tint.': l10n.t('The material vertex-colour tint.'),
    anim: l10n.t('anim'),
    Beam: l10n.t('Beam'),
    'The per-vertex beam inputs: intensity scales the effect, fade multiplies alpha over the beam’s life.': l10n.t(
        'The per-vertex beam inputs: intensity scales the effect, fade multiplies alpha over the beam’s life.'
    ),
    'Sprite cell': l10n.t('Sprite cell'),
    'The particle system picks one cell of the sprite sheet (UvSprites). Cycle replays the animation over the lifetime.':
        l10n.t(
            'The particle system picks one cell of the sprite sheet (UvSprites). Cycle replays the animation over the lifetime.'
        ),
    cycle: l10n.t('cycle'),
    '{0} (default {1})': l10n.t('{0} (default {1})'),
    'Replay the engine clock driving this constant. Uncheck to set it manually.': l10n.t(
        'Replay the engine clock driving this constant. Uncheck to set it manually.'
    ),
    auto: l10n.t('auto'),
    'Preview backdrop': l10n.t('Preview backdrop'),
    Checker: l10n.t('Checker'),
    Dark: l10n.t('Dark'),
    Light: l10n.t('Light'),
    Grey: l10n.t('Grey'),
    Backdrop: l10n.t('Backdrop'),
    'Blend mode (the material’s resolved mode, overridable)': l10n.t(
        'Blend mode (the material’s resolved mode, overridable)'
    ),
    material: l10n.t('material'),
    Blend: l10n.t('Blend'),
    Pause: l10n.t('Pause'),
    Play: l10n.t('Play'),
    'shader compile failed': l10n.t('shader compile failed'),
    'shader compile failed: {0}': l10n.t('shader compile failed: {0}'),
    'shader not translatable': l10n.t('shader not translatable'),
    'Approximate render ({0}). Texture, tint and blend shown.': l10n.t(
        'Approximate render ({0}). Texture, tint and blend shown.'
    ),
    'Live translated shader.': l10n.t('Live translated shader.'),
    'vertex stage ({0})': l10n.t('vertex stage ({0})'),
    'particle: color ramp animated': l10n.t('particle: color ramp animated'),
    'particle: vertex colour animated': l10n.t('particle: vertex colour animated'),
    beam: l10n.t('beam'),
    'sprite sheet: {0} cells': l10n.t('sprite sheet: {0} cells'),
    'scene stand-in': l10n.t('scene stand-in'),
    'WebGL1 fallback': l10n.t('WebGL1 fallback'),
    'Open .shader': l10n.t('Open .shader'),
    'Place the cursor in a material with a Shader to preview it.': l10n.t(
        'Place the cursor in a material with a Shader to preview it.'
    ),
    'WebGL is not available in this webview.': l10n.t('WebGL is not available in this webview.'),
});

/**
 * The text the diagram page shows.
 *
 * @returns every string the page looks up, keyed by its English source.
 */
export const diagramViewStrings = (): Record<string, string> => ({
    'Fit the whole diagram into the panel': l10n.t('Fit the whole diagram into the panel'),
    'Filter boxes': l10n.t('Filter boxes'),
    'Nothing to draw here.': l10n.t('Nothing to draw here.'),
});

/**
 * The text the part table page shows.
 *
 * @returns every string the page looks up, keyed by its English source.
 */
export const partTableStrings = (): Record<string, string> => ({
    'Filter parts': l10n.t('Filter parts'),
    'Search columns': l10n.t('Search columns'),
    'Column name': l10n.t('Column name'),
    '[MaxHealth] / [@Tiles]': l10n.t('[MaxHealth] / [@Tiles]'),
    'Following your edit…': l10n.t('Following your edit…'),
    'No group': l10n.t('No group'),
    'No grouping': l10n.t('No grouping'),
    'By build menu group': l10n.t('By build menu group'),
    'By ship class, then build menu group': l10n.t('By ship class, then build menu group'),
    'By ship class': l10n.t('By ship class'),
    'No ship class': l10n.t('No ship class'),
    'No category': l10n.t('No category'),
    'No mod': l10n.t('No mod'),
    'Ship class': l10n.t('Ship class'),
    Category: l10n.t('Category'),
    Mod: l10n.t('Mod'),
    'All parts': l10n.t('All parts'),
    'The game and {0}': l10n.t('The game and {0}'),
    'The game alone. Open a file of your mod to add it.': l10n.t('The game alone. Open a file of your mod to add it.'),
    'Show tree': l10n.t('Show tree'),
    'Hide tree': l10n.t('Hide tree'),
    'By category': l10n.t('By category'),
    'By mod': l10n.t('By mod'),
    Group: l10n.t('Group'),
    'Show these parts': l10n.t('Show these parts'),
    'Hide these parts': l10n.t('Hide these parts'),
    Average: l10n.t('Average'),
    Least: l10n.t('Least'),
    Most: l10n.t('Most'),
    'Every number is per tile.': l10n.t('Every number is per tile.'),
    computed: l10n.t('computed'),
    'Formula: {0}': l10n.t('Formula: {0}'),
    'Write 1 change to the files': l10n.t('Write 1 change to the files'),
    'Write {0} changes to the files': l10n.t('Write {0} changes to the files'),
    'Discard typed values': l10n.t('Discard typed values'),
    'Write a number, with the % d or r suffix the value already has.': l10n.t(
        'Write a number, with the % d or r suffix the value already has.'
    ),
    'Typed over {0}. Write the changes to put it in the file.': l10n.t(
        'Typed over {0}. Write the changes to put it in the file.'
    ),
    'Typed over. Write the changes to put it in the file.': l10n.t(
        'Typed over. Write the changes to put it in the file.'
    ),
    'Inherited. Click to open the declaration, double-click to try a value.': l10n.t(
        'Inherited. Click to open the declaration, double-click to try a value.'
    ),
    'Click to open the declaration, double-click to try a value.': l10n.t(
        'Click to open the declaration, double-click to try a value.'
    ),
    'Credits paid for every point of health': l10n.t('Credits paid for every point of health'),
    'Damage per second for every credit': l10n.t('Damage per second for every credit'),
    'Damage per shot times fire rate, times the barrels where a part counts them': l10n.t(
        'Damage per shot times fire rate, times the barrels where a part counts them'
    ),
    'Steel and coils added up, for the parts that take only one of them too': l10n.t(
        'Steel and coils added up, for the parts that take only one of them too'
    ),
    'Every resource the part takes, added up': l10n.t('Every resource the part takes, added up'),
    'Percent of the average of the parts on screen': l10n.t('Percent of the average of the parts on screen'),
    'Rank by health, 1 for the highest': l10n.t('Rank by health, 1 for the highest'),
    'Reading the parts…': l10n.t('Reading the parts…'),
    'Reading the picked columns…': l10n.t('Reading the picked columns…'),
    'Narrowing to the parts you picked…': l10n.t('Narrowing to the parts you picked…'),
    'Putting the view back…': l10n.t('Putting the view back…'),
    'No view saved yet.': l10n.t('No view saved yet.'),
    'Insert a column on screen:': l10n.t('Insert a column on screen:'),
    'No column is on screen to insert.': l10n.t('No column is on screen to insert.'),
    Delete: l10n.t('Delete'),
    '{0} of {1} columns shown': l10n.t('{0} of {1} columns shown'),
    'Freeze this column at the left edge': l10n.t('Freeze this column at the left edge'),
    'Drag to set the width, double-click to let the column size itself': l10n.t(
        'Drag to set the width, double-click to let the column size itself'
    ),
    'Unfreeze this column': l10n.t('Unfreeze this column'),
    'Every number is shown as its percentage of the compared part, so 200% is twice as much.': l10n.t(
        'Every number is shown as its percentage of the compared part, so 200% is twice as much.'
    ),
    'Pick a part to compare against first.': l10n.t('Pick a part to compare against first.'),
    'Blue is below the compared part, grey within half a percent of it, red above it. The deeper shade is past twice or under half. The colour says where the number stands, not whether that is better.':
        l10n.t(
            'Blue is below the compared part, grey within half a percent of it, red above it. The deeper shade is past twice or under half. The colour says where the number stands, not whether that is better.'
        ),
    'Health for every cell the part takes up': l10n.t('Health for every cell the part takes up'),
    'Rounded to one decimal': l10n.t('Rounded to one decimal'),
    'Percent of the compared part': l10n.t('Percent of the compared part'),
    '1 for the parts above ten thousand health, 0 for the rest': l10n.t(
        '1 for the parts above ten thousand health, 0 for the rest'
    ),
    'The larger of two columns': l10n.t('The larger of two columns'),
    Part: l10n.t('Part'),
    From: l10n.t('From'),
    'Every category': l10n.t('Every category'),
    'Every component': l10n.t('Every component'),
    Everywhere: l10n.t('Everywhere'),
    'Compare with nothing': l10n.t('Compare with nothing'),
    'No parts found.': l10n.t('No parts found.'),
    'No part matches the filter.': l10n.t('No part matches the filter.'),
    'No column matches.': l10n.t('No column matches.'),
    'Click to open the declaration.': l10n.t('Click to open the declaration.'),
    'Inherited. Click to open the declaration.': l10n.t('Inherited. Click to open the declaration.'),
    '{0} of {1} parts': l10n.t('{0} of {1} parts'),
    '{0} parts': l10n.t('{0} parts'),
    'The project holds more parts than the table reads.': l10n.t('The project holds more parts than the table reads.'),
});
