import { pgTable, serial, timestamp, varchar, text, boolean, jsonb, integer, index } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const articles = pgTable(
  "articles",
  {
    id: serial().primaryKey(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    content: text("content").notNull(),
    country_code: varchar("country_code", { length: 10 }).notNull(),
    category: varchar("category", { length: 30 }).notNull(),
    source_name: varchar("source_name", { length: 100 }).notNull(),
    source_url: text("source_url"),
    original_title: text("original_title"),
    original_content: text("original_content"),
    original_language: varchar("original_language", { length: 10 }),
    published_at: timestamp("published_at", { withTimezone: true }).notNull(),
    tags: jsonb("tags").$type<string[]>(),
    is_featured: boolean("is_featured").default(false).notNull(),
    cover_image: text("cover_image"),
    image_urls: jsonb("image_urls").$type<string[]>(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => [
    index("articles_country_code_idx").on(table.country_code),
    index("articles_category_idx").on(table.category),
    index("articles_published_at_idx").on(table.published_at),
    index("articles_is_featured_idx").on(table.is_featured),
  ]
);
