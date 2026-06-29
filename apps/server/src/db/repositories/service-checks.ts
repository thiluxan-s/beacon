import { db } from '../index';
import { serviceChecks, type NewServiceCheck } from '../schema';

export async function recordCheck(input: NewServiceCheck): Promise<void> {
  await db.insert(serviceChecks).values(input);
}
