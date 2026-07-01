export const ALLOWED_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg'];
export const ALLOWED_IMAGE_EXTENSIONS = ['.png'];
export const ALLOWED_SHADER_EXTENSIONS = ['.shader'];

/**
 * The on-disk file extensions an asset value of the given kind can point at.
 * @param type the asset kind to resolve extensions for
 * @returns the file extensions allowed for that asset kind
 */
export const assetExtensionsForType = (type: 'Sprite' | 'Sound' | 'Shader'): string[] => {
    switch (type) {
        case 'Sprite':
            return ALLOWED_IMAGE_EXTENSIONS;
        case 'Sound':
            return ALLOWED_AUDIO_EXTENSIONS;
        case 'Shader':
            return ALLOWED_SHADER_EXTENSIONS;
    }
};
