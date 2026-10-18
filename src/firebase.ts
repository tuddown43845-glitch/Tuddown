import { initializeApp } from 'firebase/app';
import {
  collection,
  doc,
  deleteDoc,
  getDocs,
  initializeFirestore,
  onSnapshot,
  setDoc,
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
const firestoreDbId =
  (firebaseConfig as any).firestoreDatabaseId ||
  'ai-studio-03fa31d5-9cdf-4fa8-8703-f0e02c1b6f4e';

const db = initializeFirestore(
  app,
  { ignoreUndefinedProperties: true },
  firestoreDbId,
);
const auth = getAuth(app);

export type SharedCollectionName =
  | 'students'
  | 'mcqs'
  | 'subjs'
  | 'submissions'
  | 'settings';

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
        .map((snapshotDoc) => {
          const data = snapshotDoc.data();
          return {
            id: String(data.id || snapshotDoc.id),
            ...data,
          } as T & { __order?: number };
        })
        .filter((item) => {
          if (!item) return false;
          if (name === 'mcqs') {
            const mcq = item as any;
            return Boolean(mcq.text && Array.isArray(mcq.options) && mcq.options.length > 0);
          }
          if (name === 'subjs') {
            const subj = item as any;
            return Boolean(subj.text);
          }
          if (name === 'students') {
            const st = item as any;
            return Boolean(st.name && st.id);
          }
          return true;
        })
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

/**
 * Direct single submission upload.
 * Writing directly to doc(db, 'exam_submissions', sub.id) does NOT query other submissions,
 * eliminating network congestion and race conditions when dozens of students submit simultaneously.
 */
export const saveSubmissionDirectly = async (
  sub: { id: string; [key: string]: unknown },
): Promise<{ success: boolean; error?: string }> => {
  const docRef = doc(db, 'exam_submissions', String(sub.id));
  
  // Try up to 3 times with progressive delays
  const delays = [0, 800, 1600];
  let lastError: any = null;

  for (let i = 0; i < delays.length; i++) {
    try {
      if (delays[i] > 0) {
        await new Promise((res) => setTimeout(res, delays[i]));
      }
      await setDoc(docRef, sub, { merge: true });
      // If success, remove from pending queue if present
      try {
        const pendingRaw = localStorage.getItem('pending_exam_submissions');
        if (pendingRaw) {
          const list: any[] = JSON.parse(pendingRaw);
          const filtered = list.filter((item) => item.id !== sub.id);
          localStorage.setItem('pending_exam_submissions', JSON.stringify(filtered));
        }
      } catch {}
      return { success: true };
    } catch (err: any) {
      lastError = err;
      console.warn(`saveSubmissionDirectly attempt ${i + 1} failed:`, err);
    }
  }

  // If all attempts failed, store in pending queue for background retry
  try {
    const pendingRaw = localStorage.getItem('pending_exam_submissions');
    const list: any[] = pendingRaw ? JSON.parse(pendingRaw) : [];
    if (!list.some((item) => item.id === sub.id)) {
      list.push(sub);
      localStorage.setItem('pending_exam_submissions', JSON.stringify(list));
    }
  } catch {}

  console.error('saveSubmissionDirectly all retries failed:', lastError);
  return { success: false, error: lastError?.message || String(lastError) };
};

/**
 * Flush any pending offline submissions when connection recovers
 */
export const flushPendingSubmissions = async (): Promise<number> => {
  try {
    const pendingRaw = localStorage.getItem('pending_exam_submissions');
    if (!pendingRaw) return 0;
    const list: any[] = JSON.parse(pendingRaw);
    if (!Array.isArray(list) || list.length === 0) return 0;

    let syncedCount = 0;
    const remaining: any[] = [];
    for (const sub of list) {
      try {
        const docRef = doc(db, 'exam_submissions', String(sub.id));
        await setDoc(docRef, sub, { merge: true });
        syncedCount++;
      } catch {
        remaining.push(sub);
      }
    }
    localStorage.setItem('pending_exam_submissions', JSON.stringify(remaining));
    return syncedCount;
  } catch {
    return 0;
  }
};

/**
 * Delete a single student submission directly from Cloud Firestore
 */
export const deleteSubmissionDirectly = async (submissionId: string): Promise<boolean> => {
  try {
    const docRef = doc(db, 'exam_submissions', String(submissionId));
    await deleteDoc(docRef);

    // Also remove from pending offline queue if present
    try {
      const pendingRaw = localStorage.getItem('pending_exam_submissions');
      if (pendingRaw) {
        const list: any[] = JSON.parse(pendingRaw);
        const filtered = list.filter((item) => String(item.id) !== String(submissionId));
        localStorage.setItem('pending_exam_submissions', JSON.stringify(filtered));
      }
    } catch {}

    return true;
  } catch (err) {
    console.error('deleteSubmissionDirectly error:', err);
    return false;
  }
};

/**
 * Delete multiple student submissions directly from Cloud Firestore in batch
 */
export const deleteSubmissionsBatch = async (submissionIds: string[]): Promise<boolean> => {
  try {
    if (submissionIds.length === 0) return true;
    const actions: BatchAction[] = submissionIds.map((id) => ({
      type: 'delete',
      ref: doc(db, 'exam_submissions', String(id)),
    }));
    await commitActions(actions);

    // Also remove from pending offline queue
    try {
      const pendingRaw = localStorage.getItem('pending_exam_submissions');
      if (pendingRaw) {
        const idSet = new Set(submissionIds.map(String));
        const list: any[] = JSON.parse(pendingRaw);
        const filtered = list.filter((item) => !idSet.has(String(item.id)));
        localStorage.setItem('pending_exam_submissions', JSON.stringify(filtered));
      }
    } catch {}

    return true;
  } catch (err) {
    console.error('deleteSubmissionsBatch error:', err);
    return false;
  }
};

/**
 * Clear all student exam submissions directly from Cloud Firestore
 */
export const clearAllSubmissionsDirectly = async (): Promise<boolean> => {
  try {
    const ref = collection(db, 'exam_submissions');
    const snapshot = await getDocs(ref);
    const actions: BatchAction[] = snapshot.docs.map((d) => ({
      type: 'delete',
      ref: d.ref,
    }));
    await commitActions(actions);

    // Clear local pending submissions
    try {
      localStorage.removeItem('pending_exam_submissions');
    } catch {}

    return true;
  } catch (err) {
    console.error('clearAllSubmissionsDirectly error:', err);
    return false;
  }
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
