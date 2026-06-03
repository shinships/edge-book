import { db } from '../db';
import { todos } from '../db/schema';
import { eq, and } from 'drizzle-orm';

export interface TodoItem {
    id: number;
    task: string;
    completed: boolean;
    createdAt: string;
}

type TodoRow = typeof todos.$inferSelect;

function toItem(row: TodoRow): TodoItem {
    return {
        id: row.id,
        task: row.task,
        completed: row.completed,
        createdAt: row.createdAt.toISOString(),
    };
}

export class TodoService {
    async getTodos(userId: number): Promise<TodoItem[]> {
        const rows = await db.select().from(todos).where(eq(todos.userId, userId));
        return rows.map(toItem);
    }

    async addTodo(userId: number, task: string): Promise<void> {
        await db.insert(todos).values({
            id: Date.now(),
            userId,
            task,
            completed: false,
            createdAt: new Date(),
        });
    }

    async completeTodo(userId: number, keywordOrIndex: string): Promise<TodoItem | null> {
        const items = await this.getTodos(userId);
        const index = parseInt(keywordOrIndex);

        let target: TodoItem | undefined;
        if (!isNaN(index) && index > 0 && index <= items.length) {
            target = items[index - 1];
        } else {
            target = items.find(
                (i) => i.task.toLowerCase().includes(keywordOrIndex.toLowerCase()) && !i.completed
            );
        }

        if (!target) return null;

        await db.update(todos)
            .set({ completed: true })
            .where(eq(todos.id, target.id));
        return { ...target, completed: true };
    }

    async clearCompleted(userId: number): Promise<void> {
        await db.delete(todos)
            .where(and(eq(todos.userId, userId), eq(todos.completed, true)));
    }
}
