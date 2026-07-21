import { defineCollection } from 'astro:content';
import { z } from 'astro/zod'; 
import { glob } from 'astro/loaders'; 

const essaysCollection = defineCollection({
    loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/essays" }),
    schema: z.object({
        title: z.string(),
        pubDate: z.date(),
        description: z.string(),
        featured: z.boolean().default(false),
    }),
});

export const collections = {
    'essays': essaysCollection,
};