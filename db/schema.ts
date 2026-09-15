import {sqliteTable,text,integer} from "drizzle-orm/sqlite-core";
export const portfolios=sqliteTable("portfolios",{id:text("id").primaryKey(),owner:text("owner").notNull(),exchange:text("exchange").notNull(),data:text("data").notNull(),version:integer("version").notNull().default(0)});
