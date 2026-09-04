import { Room } from './room';
import { randomRoomCode } from './codes';

const IDLE_TTL_MS = 10 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly log: (msg: string) => void) {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  create(): Room {
    let code = randomRoomCode();
    while (this.rooms.has(code)) code = randomRoomCode();
    const room = new Room(code, this.log);
    this.rooms.set(code, room);
    this.log(`room ${code} created (${this.rooms.size} open)`);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  get size(): number {
    return this.rooms.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.isIdle() && now - room.lastActivity > IDLE_TTL_MS) {
        room.destroy();
        this.rooms.delete(code);
        this.log(`room ${code} expired (${this.rooms.size} open)`);
      }
    }
  }
}
