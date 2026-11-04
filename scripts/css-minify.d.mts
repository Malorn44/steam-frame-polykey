import type { Plugin } from 'esbuild';

export declare const minifyCss: (css: string) => string;
export declare const cssTemplates: (source: string) => string[];
export declare const minifyCssTemplates: (source: string) => string;
export declare const cssMinify: Plugin;
