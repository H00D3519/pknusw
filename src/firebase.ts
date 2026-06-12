import { initializeApp } from "firebase/app";
import {
  child,
  get,
  getDatabase,
  onValue,
  ref,
  remove,
  set,
  update,
  type Database,
} from "firebase/database";

export type StorageMode = "firebase" | "local";

export type Expense = {
  id: string;
  title: string;
  amount: number;
  payer: string;
  participants: string[];
  memo: string;
  createdAt: number;
};

export type PaidTransfer = {
  id: string;
  from: string;
  to: string;
  amount: number;
  isPaid: boolean;
  updatedAt: number;
};

export type Room = {
  id: string;
  shareCode: string;
  title: string;
  members: string[];
  expenses: Record<string, Expense>;
  paidTransfers: Record<string, PaidTransfer>;
  createdAt: number;
  updatedAt: number;
};

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

let database: Database | null = null;
let storageMode: StorageMode = "local";

export function hasFirebaseEnv() {
  return Object.values(firebaseConfig).every((value) => Boolean(value));
}

try {
  if (hasFirebaseEnv()) {
    const app = initializeApp(firebaseConfig);
    database = getDatabase(app);
    storageMode = "firebase";
  }
} catch (error) {
  console.warn("Firebase initialization failed. Falling back to localStorage.", error);
  database = null;
  storageMode = "local";
}

export function getStorageMode(): StorageMode {
  return storageMode;
}

function switchToLocalMode(error: unknown) {
  console.warn("Firebase request failed. Falling back to localStorage.", error);
  database = null;
  storageMode = "local";
}

function roomKey(shareCode: string) {
  return `settlementRoom:${shareCode}`;
}

function normalizeRoom(room: Room | null): Room | null {
  if (!room) return null;
  return {
    ...room,
    expenses: room.expenses ?? {},
    paidTransfers: room.paidTransfers ?? {},
  };
}

function getLocalRoom(shareCode: string): Room | null {
  try {
    const stored = localStorage.getItem(roomKey(shareCode));
    return normalizeRoom(stored ? (JSON.parse(stored) as Room) : null);
  } catch (error) {
    console.warn("Failed to read local room.", error);
    return null;
  }
}

function mirrorLocalRoom(room: Room) {
  try {
    localStorage.setItem(roomKey(room.shareCode), JSON.stringify(normalizeRoom(room)));
  } catch (error) {
    console.warn("Failed to mirror local room.", error);
  }
}

function saveLocalRoom(room: Room) {
  mirrorLocalRoom(room);
  window.dispatchEvent(new CustomEvent(`settlementRoomChanged:${room.shareCode}`));
}

export async function createRoom(room: Room): Promise<void> {
  if (database) {
    try {
      await set(ref(database, `rooms/${room.shareCode}`), room);
      mirrorLocalRoom(room);
      return;
    } catch (error) {
      switchToLocalMode(error);
    }
  }

  saveLocalRoom(room);
}

export async function roomExists(shareCode: string): Promise<boolean> {
  if (database) {
    try {
      const snapshot = await get(child(ref(database), `rooms/${shareCode}`));
      return snapshot.exists();
    } catch (error) {
      switchToLocalMode(error);
    }
  }

  return getLocalRoom(shareCode) !== null;
}

export function subscribeRoom(
  shareCode: string,
  callback: (room: Room | null) => void,
): () => void {
  if (database) {
    try {
      const roomRef = ref(database, `rooms/${shareCode}`);
      return onValue(
        roomRef,
        (snapshot) => {
          const nextRoom = normalizeRoom(snapshot.val() as Room | null);
          if (nextRoom) mirrorLocalRoom(nextRoom);
          callback(nextRoom);
        },
        (error) => {
          switchToLocalMode(error);
          callback(getLocalRoom(shareCode));
        },
      );
    } catch (error) {
      switchToLocalMode(error);
    }
  }

  const emitLocalRoom = () => callback(getLocalRoom(shareCode));
  emitLocalRoom();

  const customEvent = `settlementRoomChanged:${shareCode}`;
  const handleStorage = (event: StorageEvent) => {
    if (event.key === roomKey(shareCode)) emitLocalRoom();
  };
  const handleCustom = () => emitLocalRoom();

  window.addEventListener("storage", handleStorage);
  window.addEventListener(customEvent, handleCustom);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(customEvent, handleCustom);
  };
}

export async function addExpense(shareCode: string, expense: Expense): Promise<void> {
  if (database) {
    try {
      await update(ref(database, `rooms/${shareCode}`), { updatedAt: Date.now() });
      await set(ref(database, `rooms/${shareCode}/expenses/${expense.id}`), expense);
      return;
    } catch (error) {
      switchToLocalMode(error);
    }
  }

  const room = getLocalRoom(shareCode);
  if (!room) return;

  saveLocalRoom({
    ...room,
    expenses: {
      ...room.expenses,
      [expense.id]: expense,
    },
    updatedAt: Date.now(),
  });
}

export async function deleteExpense(shareCode: string, expenseId: string): Promise<void> {
  if (database) {
    try {
      await remove(ref(database, `rooms/${shareCode}/expenses/${expenseId}`));
      await update(ref(database, `rooms/${shareCode}`), { updatedAt: Date.now() });
      return;
    } catch (error) {
      switchToLocalMode(error);
    }
  }

  const room = getLocalRoom(shareCode);
  if (!room) return;

  const nextExpenses = { ...room.expenses };
  delete nextExpenses[expenseId];

  saveLocalRoom({
    ...room,
    expenses: nextExpenses,
    updatedAt: Date.now(),
  });
}

export async function updatePaidTransfer(
  shareCode: string,
  transfer: PaidTransfer,
): Promise<void> {
  if (database) {
    try {
      await set(ref(database, `rooms/${shareCode}/paidTransfers/${transfer.id}`), transfer);
      await update(ref(database, `rooms/${shareCode}`), { updatedAt: Date.now() });
      return;
    } catch (error) {
      switchToLocalMode(error);
    }
  }

  const room = getLocalRoom(shareCode);
  if (!room) return;

  saveLocalRoom({
    ...room,
    paidTransfers: {
      ...room.paidTransfers,
      [transfer.id]: transfer,
    },
    updatedAt: Date.now(),
  });
}
