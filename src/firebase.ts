import { initializeApp } from 'firebase/app';
import {
  collection,
  doc,
  getDocs,
  initializeFirestore,
  onSnapshot,
  writeBatch,
  type DocumentReference,
  type FirestoreError,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

// ignoreUndefinedProperties prevents optional fields such as image from
// causing Firestore writes to fail when their value is undefined.
// ใช้ฐานข้อมูลที่ Firebase/AI Studio สร้างไว้แล้วในแพ็กเกจฟรี
// จึงไม่ต้องสร้างฐานข้อมูล (default) และไม่ต้องอัปเกรดแบบเสียเงิน
const FIRESTORE_DATABASE_ID =
  'ai-studio-03fa31d5-9cdf-4fa8-8703-f0e02c1b6f4e';

const db = initializeFirestore(
  app,
  { ignoreUndefinedProperties: true },
  FIRESTORE_DATABASE_ID,
);
const auth = getAuth(app);

export type SharedCollectionName =
  | 'students'
  | 'mcqs'
  | 'subjs'
  | 'submissions';

type SharedItem = { id: string };
type BatchAction =
  | { type: 'set'; ref: DocumentReference; data: Record<string, unknown> }
  | { type: 'delete'; ref: DocumentReference };

const getCollectionRef = (name: SharedCollectionName) =>
  collection(db, `exam_${name}`);

const commitActions = async (actions: BatchAction[]) => {
  // Firestore allows at most 500 operations per batch. Use 400 to leave room.
  for (let start = 0; start < actions.length; start += 400) {
    const batch = writeBatch(db);
    const chunk = actions.slice(start, start + 400);

    chunk.forEach((action) => {
      if (action.type === 'set') {
        batch.set(action.ref, action.data);
      } else {
        batch.delete(action.ref);
      }
    });

    await batch.commit();
  }
};

/**
 * Listen to a shared collection in real time. Every browser receives the same
 * data immediately after an administrator publishes a change.
 */
export const subscribeSharedCollection = <T extends SharedItem>(
  name: SharedCollectionName,
  onData: (items: T[]) => void,
  onError?: (error: FirestoreError) => void,
): Unsubscribe => {
  return onSnapshot(
    getCollectionRef(name),
    (snapshot) => {
      const items = snapshot.docs
        .map((snapshotDoc) => snapshotDoc.data() as T & { __order?: number })
        .sort((a, b) => (a.__order ?? 0) - (b.__order ?? 0))
        .map((item) => {
          const { __order: _order, ...cleanItem } = item;
          return cleanItem as T;
        });

      onData(items);
    },
    onError,
  );
};

/**
 * Make Firestore match the supplied array exactly. This is used for students
 * and question banks, where the administrator may add, edit, or delete items.
 */
export const replaceSharedCollection = async <T extends SharedItem>(
  name: SharedCollectionName,
  items: T[],
): Promise<void> => {
  const ref = getCollectionRef(name);
  const existingSnapshot = await getDocs(ref);
  const existingByItemId = new Map<string, DocumentReference>();

  existingSnapshot.docs.forEach((snapshotDoc) => {
    const itemId = String(snapshotDoc.data().id ?? '');
    if (itemId) existingByItemId.set(itemId, snapshotDoc.ref);
  });

  const uniqueItems = Array.from(
    new Map(items.map((item) => [String(item.id), item])).values(),
  );
  const incomingIds = new Set(uniqueItems.map((item) => String(item.id)));
  const actions: BatchAction[] = [];

  existingSnapshot.docs.forEach((snapshotDoc) => {
    const itemId = String(snapshotDoc.data().id ?? '');
    if (!incomingIds.has(itemId)) {
      actions.push({ type: 'delete', ref: snapshotDoc.ref });
    }
  });

  uniqueItems.forEach((item, index) => {
    const itemId = String(item.id);
    const documentRef = existingByItemId.get(itemId) ?? doc(ref);
    actions.push({
      type: 'set',
      ref: documentRef,
      data: { ...item, __order: index },
    });
  });

  await commitActions(actions);
};

/**
 * Add or update items without deleting anything that another browser may have
 * submitted at the same time. This is especially important for exam results.
 */
export const upsertSharedItems = async <T extends SharedItem>(
  name: SharedCollectionName,
  items: T[],
): Promise<void> => {
  const ref = getCollectionRef(name);
  const existingSnapshot = await getDocs(ref);
  const existingByItemId = new Map<string, DocumentReference>();

  existingSnapshot.docs.forEach((snapshotDoc) => {
    const itemId = String(snapshotDoc.data().id ?? '');
    if (itemId) existingByItemId.set(itemId, snapshotDoc.ref);
  });

  const uniqueItems = Array.from(
    new Map(items.map((item) => [String(item.id), item])).values(),
  );
  const actions: BatchAction[] = uniqueItems.map((item, index) => {
    const itemId = String(item.id);
    return {
      type: 'set' as const,
      ref: existingByItemId.get(itemId) ?? doc(ref),
      data: { ...item, __order: index },
    };
  });

  await commitActions(actions);
};

// Existing Google sign-in helpers are kept for compatibility with any other
// project files, but App.tsx no longer needs Google sign-in to import students.
const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive');
provider.addScope('https://www.googleapis.com/auth/spreadsheets');

let isSigningIn = false;
let cachedAccessToken: string | null = null;

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void,
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user && cachedAccessToken) {
      onAuthSuccess?.(user, cachedAccessToken);
    } else if (!isSigningIn) {
      cachedAccessToken = null;
      onAuthFailure?.();
    }
  });
};

export const googleSignIn = async (): Promise<{
  user: User;
  accessToken: string;
} | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);

    if (!credential?.accessToken) {
      throw new Error('Failed to get access token from Firebase Auth');
    }

    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> =>
  cachedAccessToken;

export const logoutGoogle = async () => {
  await auth.signOut();
  cachedAccessToken = null;
};
