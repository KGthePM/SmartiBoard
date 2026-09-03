/**
 * The one non-standard attribute folder import needs that lib.dom does not
 * declare: `<input webkitdirectory>`. `webkitRelativePath` (File) and
 * `webkitGetAsEntry()` (DataTransferItem) are already in lib.dom.
 */
import type { HTMLAttributes } from 'react';

declare module 'react' {
  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    /** Non-standard: the file picker selects directories instead of files. */
    webkitdirectory?: boolean | '';
  }
}
