import { initializeApp } from 'firebase/app';
import {
  collection,
  doc,
  deleteDoc,
  getDoc,
  getDocFromServer,
  getDocs,
  initializeFirestore,
  onSnapshot,
  query,
  setDoc,
  where,
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
import {
  DEFAULT_COURSE,
  DEFAULT_COURSE_ID,
  createDefaultSettings,
  getItemCourseId,
  getSettingsDocId,
  type Course,
  type MCQ,
  type Settings,
  type Student,
  type Subjective,
  type Submission,
  type Teacher,
} from './types';

const app = initializeApp(firebaseConfig);

const firestoreDbId =
  (firebaseConfig as any).firestoreDatabaseId ||
  'ai-studio-03fa31d5-9cdf-4fa8-8703-f0e02c1b6f4e';

export const db = initializeFirestore(
  app,
  { ignoreUndefinedProperties: true },
  firestoreDbId,
);
export const auth = getAuth(app);

// --- CONNECTION VALIDATION & STRUCTURED ERROR HANDLING ---
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration (client is offline).');
      return false;
    }
    return true;
  }
}

void testConnection();

export type SharedCollectionName =
  | 'students'
  | 'mcqs'
  | 'subjs'
  | 'submissions'
  | 'settings'
  | 'teachers'
  | 'courses';

type SharedItem = { id: string };
type BatchAction =
  | { type: 'set'; ref: DocumentReference; data: Record<string, unknown> }
  | { type: 'delete'; ref: DocumentReference };

const getCollectionRef = (name: SharedCollectionName) =>
  collection(db, `exam_${name}`);

const commitActions = async (actions: BatchAction[], pathLabel = 'batch') => {
  try {
    for (let start = 0; start < actions.length; start += 400) {
      const batch = writeBatch(db);
      const chunk = actions.slice(start, start + 400);

      chunk.forEach((action) => {
        if (action.type === 'set') {
          batch.set(action.ref, action.data, { merge: true });
        } else {
          batch.delete(action.ref);
        }
      });

      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, pathLabel);
  }
};

const filterValidItems = <T extends SharedItem>(
  name: SharedCollectionName,
  items: (T & { __order?: number })[],
): T[] => {
  return items
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
      if (name === 'teachers') {
        const t = item as any;
        return Boolean(t.username && t.name);
      }
      if (name === 'courses') {
        const c = item as any;
        return Boolean(c.name && c.code);
      }
      return true;
    })
    .sort((a, b) => (a.__order ?? 0) - (b.__order ?? 0))
    .map((item) => {
      const { __order: _order, ...cleanItem } = item;
      return cleanItem as T;
    });
};

// --- GRANULAR SINGLE-DOCUMENT & BATCH CRUD (NO FULL-COLLECTION OVERWRITES) ---

/**
 * Resolve existing DocumentReference by deterministic ID first, or legacy `where('id', '==', itemId)` fallback.
 */
const resolveExistingDocRefs = async (
  name: SharedCollectionName,
  itemId: string,
): Promise<DocumentReference[]> => {
  const ref = getCollectionRef(name);
  const refs: DocumentReference[] = [];
  const seenPaths = new Set<string>();

  const directRef = doc(ref, itemId);
  try {
    const directSnap = await getDoc(directRef);
    if (directSnap.exists()) {
      refs.push(directRef);
      seenPaths.add(directRef.path);
    }
  } catch {
    // Ignore direct lookup issues if ID contains invalid path chars
  }

  try {
    const q = query(ref, where('id', '==', itemId));
    const snap = await getDocs(q);
    snap.docs.forEach((d) => {
      if (!seenPaths.has(d.ref.path)) {
        refs.push(d.ref);
        seenPaths.add(d.ref.path);
      }
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `exam_${name}`);
  }

  return refs;
};

/**
 * Save a single document without rewriting the entire collection.
 * Safe for concurrent multi-teacher editing and saves Firestore write quota.
 */
export const saveSingleDoc = async <T extends SharedItem>(
  name: SharedCollectionName,
  item: T,
  orderIndex?: number,
): Promise<void> => {
  const path = `exam_${name}/${item.id}`;
  try {
    const ref = getCollectionRef(name);
    const existingRefs = await resolveExistingDocRefs(name, String(item.id));
    const payload = orderIndex !== undefined ? { ...item, __order: orderIndex } : { ...item };

    if (existingRefs.length > 0) {
      await setDoc(existingRefs[0], payload, { merge: true });
      // Clean up any accidental duplicate legacy docs with the same item.id
      if (existingRefs.length > 1) {
        const extraDeletes: BatchAction[] = existingRefs.slice(1).map((r) => ({
          type: 'delete',
          ref: r,
        }));
        await commitActions(extraDeletes, path);
      }
    } else {
      const safeDocId = String(item.id).replace(/\//g, '_');
      await setDoc(doc(ref, safeDocId), payload, { merge: true });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
};

/**
 * Save multiple documents (e.g. bulk Word/Text import or bulk examType update)
 * without touching other courses' documents.
 */
export const saveBatchDocs = async <T extends SharedItem>(
  name: SharedCollectionName,
  items: T[],
  startOrderIndex = 0,
): Promise<void> => {
  if (items.length === 0) return;
  const ref = getCollectionRef(name);
  const path = `exam_${name}`;
  try {
    const actions: BatchAction[] = [];
    // For updates to potentially legacy docs, match existing IDs if small batch
    let existingByItemId = new Map<string, DocumentReference>();
    if (items.length <= 200) {
      const snap = await getDocs(ref);
      snap.docs.forEach((d) => {
        const id = String(d.data().id ?? d.id);
        if (id) existingByItemId.set(id, d.ref);
      });
    }

    items.forEach((item, idx) => {
      const itemId = String(item.id);
      const safeDocId = itemId.replace(/\//g, '_');
      const targetRef = existingByItemId.get(itemId) ?? doc(ref, safeDocId);
      actions.push({
        type: 'set',
        ref: targetRef,
        data: { ...item, __order: startOrderIndex + idx },
      });
    });

    await commitActions(actions, path);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
};

/**
 * Delete a single document by its logical `id` (handles both deterministic and legacy random Firestore IDs).
 */
export const deleteSingleDoc = async (
  name: SharedCollectionName,
  itemId: string,
): Promise<boolean> => {
  const path = `exam_${name}/${itemId}`;
  try {
    const existingRefs = await resolveExistingDocRefs(name, String(itemId));
    if (existingRefs.length === 0) return true;
    const actions: BatchAction[] = existingRefs.map((ref) => ({
      type: 'delete',
      ref,
    }));
    await commitActions(actions, path);
    return true;
  } catch (error) {
    console.error(`deleteSingleDoc ${path} error:`, error);
    return false;
  }
};

/**
 * Delete ALL documents belonging to a specific courseId (never touches other teachers' courses!).
 */
export const deleteDocsByCourse = async (
  name: 'mcqs' | 'subjs' | 'submissions',
  courseId: string,
): Promise<boolean> => {
  const path = `exam_${name}`;
  try {
    const ref = getCollectionRef(name);
    let docsToDelete: DocumentReference[] = [];

    if (courseId === DEFAULT_COURSE_ID) {
      const snap = await getDocs(ref);
      docsToDelete = snap.docs
        .filter((d) => getItemCourseId(d.data() as any) === DEFAULT_COURSE_ID)
        .map((d) => d.ref);
    } else {
      const snap = await getDocs(query(ref, where('courseId', '==', courseId)));
      docsToDelete = snap.docs.map((d) => d.ref);
    }

    if (docsToDelete.length > 0) {
      await commitActions(
        docsToDelete.map((r) => ({ type: 'delete', ref: r })),
        path,
      );
    }

    if (name === 'submissions') {
      try {
        const pendingRaw = localStorage.getItem('pending_exam_submissions');
        if (pendingRaw) {
          const list: any[] = JSON.parse(pendingRaw);
          const remaining = list.filter((s) => getItemCourseId(s) !== courseId);
          localStorage.setItem('pending_exam_submissions', JSON.stringify(remaining));
        }
      } catch {}
    }

    return true;
  } catch (error) {
    console.error(`deleteDocsByCourse ${path} (${courseId}) error:`, error);
    return false;
  }
};

/**
 * Save settings for a specific course (1 document write, instant sync across all clients).
 */
export const saveCourseSettings = async (
  courseId: string,
  settingsData: Settings,
): Promise<void> => {
  const settingsId = getSettingsDocId(courseId);
  const payload: Settings = {
    ...settingsData,
    id: settingsId,
    courseId,
  };
  await saveSingleDoc('settings', payload);
};

// --- HIGH-CONCURRENCY STUDENT ONE-TIME FETCHERS (MINIMAL FIRESTORE READS) ---

/**
 * Fetch all courses once (for Student course selection & URL resolution).
 */
export const fetchCoursesOnce = async (): Promise<Course[]> => {
  const path = 'exam_courses';
  try {
    const snap = await getDocs(getCollectionRef('courses'));
    const raw = snap.docs.map((d) => ({
      id: String(d.data().id || d.id),
      ...d.data(),
    })) as (Course & { __order?: number })[];
    const list = filterValidItems<Course>('courses', raw);
    if (!list.some((c) => c.id === DEFAULT_COURSE_ID)) {
      return [DEFAULT_COURSE, ...list];
    }
    return list;
  } catch (error) {
    console.error('fetchCoursesOnce error:', error);
    return [DEFAULT_COURSE];
  }
};

/**
 * Fetch all course settings once (so students see open/closed status on course picker without realtime fan-out).
 */
export const fetchAllSettingsOnce = async (): Promise<Record<string, Settings>> => {
  try {
    const snap = await getDocs(getCollectionRef('settings'));
    const map: Record<string, Settings> = {};
    snap.docs.forEach((d) => {
      const data = { id: String(d.data().id || d.id), ...d.data() } as Settings;
      const cid = data.courseId || (data.id === 'system_settings' ? DEFAULT_COURSE_ID : data.id.replace(/^settings_/, ''));
      map[cid] = { ...createDefaultSettings(cid), ...data, courseId: cid };
    });
    return map;
  } catch (error) {
    console.error('fetchAllSettingsOnce error:', error);
    return {};
  }
};

/**
 * Subscribe ONLY to the active course's settings document (1 doc listener!).
 * Even with 500 concurrent students, this triggers only 1 read per student when the teacher toggles Open/Close.
 */
export const subscribeCourseSettings = (
  courseId: string,
  onData: (settings: Settings) => void,
  onError?: (error: FirestoreError) => void,
): Unsubscribe => {
  const settingsId = getSettingsDocId(courseId);
  const q = query(getCollectionRef('settings'), where('id', '==', settingsId));
  return onSnapshot(
    q,
    (snapshot) => {
      if (snapshot.docs.length > 0) {
        const data = snapshot.docs[0].data() as Settings;
        onData({
          ...createDefaultSettings(courseId),
          ...data,
          id: settingsId,
          courseId,
        });
      } else {
        onData(createDefaultSettings(courseId));
      }
    },
    (error) => {
      console.error(`subscribeCourseSettings (${courseId}) error:`, error);
      onError?.(error);
    },
  );
};

/**
 * Look up a single student by ID for login (1 Firestore read instead of downloading all 500+ students!).
 */
export const findStudentById = async (studentId: string): Promise<Student | null> => {
  const trimmed = studentId.trim();
  if (!trimmed) return null;
  try {
    const ref = getCollectionRef('students');
    // 1. Try direct doc ID first
    try {
      const directSnap = await getDoc(doc(ref, trimmed));
      if (directSnap.exists()) {
        const data = directSnap.data();
        return {
          id: String(data.id || directSnap.id),
          name: String(data.name || ''),
          class: String(data.class || ''),
          number: Number(data.number || 0),
        };
      }
    } catch {}

    // 2. Fallback query by `id` field (for legacy random doc IDs)
    const snap = await getDocs(query(ref, where('id', '==', trimmed)));
    if (snap.docs.length > 0) {
      const data = snap.docs[0].data();
      return {
        id: String(data.id || snap.docs[0].id),
        name: String(data.name || ''),
        class: String(data.class || ''),
        number: Number(data.number || 0),
      };
    }
    return null;
  } catch (error) {
    console.error('findStudentById error:', error);
    return null;
  }
};

/**
 * Verify teacher login credentials against `exam_teachers` (1 Firestore read!).
 */
export const verifyTeacherLogin = async (
  username: string,
  passwordHash: string,
): Promise<{ teacher: Teacher | null; disabled?: boolean }> => {
  const cleanUser = username.trim();
  if (!cleanUser) return { teacher: null };
  try {
    const snap = await getDocs(
      query(getCollectionRef('teachers'), where('username', '==', cleanUser)),
    );
    if (snap.docs.length === 0) return { teacher: null };
    const docData = snap.docs[0].data();
    const teacher: Teacher = {
      id: String(docData.id || snap.docs[0].id),
      username: String(docData.username || ''),
      name: String(docData.name || ''),
      department: docData.department ? String(docData.department) : undefined,
      passwordHash: String(docData.passwordHash || ''),
      isActive: docData.isActive !== false,
      createdAt: Number(docData.createdAt || Date.now()),
    };
    if (teacher.passwordHash !== passwordHash) {
      return { teacher: null };
    }
    if (!teacher.isActive) {
      return { teacher: null, disabled: true };
    }
    return { teacher };
  } catch (error) {
    console.error('verifyTeacherLogin error:', error);
    return { teacher: null };
  }
};

/**
 * Fetch questions (MCQs + Subjectives) ONCE for a single course when a student logs in.
 * Eliminates real-time `onSnapshot` fan-out across hundreds of students!
 */
export const fetchCourseQuestionsOnce = async (
  courseId: string,
): Promise<{ mcqs: MCQ[]; subjs: Subjective[] }> => {
  try {
    const mcqRef = getCollectionRef('mcqs');
    const subjRef = getCollectionRef('subjs');

    const [mcqSnap, subjSnap] = await Promise.all([
      courseId === DEFAULT_COURSE_ID
        ? getDocs(mcqRef)
        : getDocs(query(mcqRef, where('courseId', '==', courseId))),
      courseId === DEFAULT_COURSE_ID
        ? getDocs(subjRef)
        : getDocs(query(subjRef, where('courseId', '==', courseId))),
    ]);

    const rawMcqs = mcqSnap.docs
      .map((d) => ({ id: String(d.data().id || d.id), ...d.data() }) as MCQ & { __order?: number })
      .filter((item) => getItemCourseId(item) === courseId);

    const rawSubjs = subjSnap.docs
      .map((d) => ({ id: String(d.data().id || d.id), ...d.data() }) as Subjective & { __order?: number })
      .filter((item) => getItemCourseId(item) === courseId);

    return {
      mcqs: filterValidItems<MCQ>('mcqs', rawMcqs),
      subjs: filterValidItems<Subjective>('subjs', rawSubjs),
    };
  } catch (error) {
    console.error(`fetchCourseQuestionsOnce (${courseId}) error:`, error);
    return { mcqs: [], subjs: [] };
  }
};

/**
 * Fetch ONLY this student's active (non-archived) submission for THIS course (0–1 read!).
 * Never downloads other students' submissions!
 */
export const fetchStudentSubmissionForCourse = async (
  studentId: string,
  courseId: string,
): Promise<Submission | null> => {
  try {
    const snap = await getDocs(
      query(getCollectionRef('submissions'), where('studentId', '==', studentId)),
    );
    const matching = snap.docs
      .map((d) => ({ id: String(d.data().id || d.id), ...d.data() }) as Submission)
      .filter((s) => getItemCourseId(s) === courseId && !s.isArchived)
      .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

    return matching[0] || null;
  } catch (error) {
    console.error('fetchStudentSubmissionForCourse error:', error);
    return null;
  }
};

// --- ADMIN / TEACHER REAL-TIME SUBSCRIPTIONS (SCOPED BY COURSE) ---

/**
 * Subscribe to a course-scoped collection (mcqs, subjs, submissions) for Admin/Teacher view.
 */
export const subscribeCourseCollection = <T extends SharedItem & { courseId?: string }>(
  name: 'mcqs' | 'subjs' | 'submissions',
  courseId: string,
  onData: (items: T[]) => void,
  onError?: (error: FirestoreError) => void,
): Unsubscribe => {
  const ref = getCollectionRef(name);
  const targetQuery =
    courseId === DEFAULT_COURSE_ID ? ref : query(ref, where('courseId', '==', courseId));

  return onSnapshot(
    targetQuery,
    (snapshot) => {
      const raw = snapshot.docs
        .map((snapshotDoc) => {
          const data = snapshotDoc.data();
          return {
            id: String(data.id || snapshotDoc.id),
            ...data,
          } as T & { __order?: number };
        })
        .filter((item) => getItemCourseId(item) === courseId);

      onData(filterValidItems<T>(name, raw));
    },
    (error) => {
      console.error(`subscribeCourseCollection (${name}, ${courseId}) error:`, error);
      onError?.(error);
    },
  );
};

export const subscribeAllCourses = (
  onData: (courses: Course[]) => void,
  onError?: (error: FirestoreError) => void,
): Unsubscribe => {
  return onSnapshot(
    getCollectionRef('courses'),
    (snapshot) => {
      const raw = snapshot.docs.map((d) => ({
        id: String(d.data().id || d.id),
        ...d.data(),
      })) as (Course & { __order?: number })[];
      const list = filterValidItems<Course>('courses', raw);
      if (!list.some((c) => c.id === DEFAULT_COURSE_ID)) {
        onData([DEFAULT_COURSE, ...list]);
      } else {
        onData(list);
      }
    },
    onError,
  );
};

export const subscribeAllSettings = (
  onData: (settingsMap: Record<string, Settings>) => void,
  onError?: (error: FirestoreError) => void,
): Unsubscribe => {
  return onSnapshot(
    getCollectionRef('settings'),
    (snapshot) => {
      const map: Record<string, Settings> = {};
      snapshot.docs.forEach((d) => {
        const data = { id: String(d.data().id || d.id), ...d.data() } as Settings;
        const cid =
          data.courseId ||
          (data.id === 'system_settings' ? DEFAULT_COURSE_ID : data.id.replace(/^settings_/, ''));
        map[cid] = { ...createDefaultSettings(cid), ...data, courseId: cid };
      });
      onData(map);
    },
    onError,
  );
};

/**
 * General collection subscription (used for students and teachers in Admin view).
 */
export const subscribeSharedCollection = <T extends SharedItem>(
  name: SharedCollectionName,
  onData: (items: T[]) => void,
  onError?: (error: FirestoreError) => void,
): Unsubscribe => {
  return onSnapshot(
    getCollectionRef(name),
    (snapshot) => {
      const items = snapshot.docs.map((snapshotDoc) => {
        const data = snapshotDoc.data();
        return {
          id: String(data.id || snapshotDoc.id),
          ...data,
        } as T & { __order?: number };
      });

      onData(filterValidItems<T>(name, items));
    },
    onError,
  );
};

/**
 * Replace an entire shared collection (used for central students roster import).
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
    const safeDocId = itemId.replace(/\//g, '_');
    const documentRef = existingByItemId.get(itemId) ?? doc(ref, safeDocId);
    actions.push({
      type: 'set',
      ref: documentRef,
      data: { ...item, __order: index },
    });
  });

  await commitActions(actions, `exam_${name}`);
};

export const upsertSharedItems = async <T extends SharedItem>(
  name: SharedCollectionName,
  items: T[],
): Promise<void> => {
  await saveBatchDocs(name, items);
};

// --- HIGH-CONCURRENCY SUBMISSION WRITER (JITTERED RETRY + OFFLINE QUEUE) ---

export const saveSubmissionDirectly = async (
  sub: { id: string; [key: string]: unknown },
): Promise<{ success: boolean; error?: string }> => {
  const docRef = doc(db, 'exam_submissions', String(sub.id));

  // Progressive retry with randomized jitter to smooth traffic spikes when 300+ students submit simultaneously
  const baseDelays = [0, 600, 1500, 3000];
  let lastError: any = null;

  for (let i = 0; i < baseDelays.length; i++) {
    try {
      if (baseDelays[i] > 0) {
        const jitter = Math.floor(Math.random() * 500);
        await new Promise((res) => setTimeout(res, baseDelays[i] + jitter));
      }
      await setDoc(docRef, sub, { merge: true });
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

  try {
    const pendingRaw = localStorage.getItem('pending_exam_submissions');
    const list: any[] = pendingRaw ? JSON.parse(pendingRaw) : [];
    const idx = list.findIndex((item) => item.id === sub.id);
    if (idx >= 0) list[idx] = sub;
    else list.push(sub);
    localStorage.setItem('pending_exam_submissions', JSON.stringify(list));
  } catch {}

  console.error('saveSubmissionDirectly all retries failed:', lastError);
  return { success: false, error: lastError?.message || String(lastError) };
};

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

export const deleteSubmissionDirectly = async (submissionId: string): Promise<boolean> => {
  try {
    const ok = await deleteSingleDoc('submissions', submissionId);
    try {
      const pendingRaw = localStorage.getItem('pending_exam_submissions');
      if (pendingRaw) {
        const list: any[] = JSON.parse(pendingRaw);
        const filtered = list.filter((item) => String(item.id) !== String(submissionId));
        localStorage.setItem('pending_exam_submissions', JSON.stringify(filtered));
      }
    } catch {}
    return ok;
  } catch (err) {
    console.error('deleteSubmissionDirectly error:', err);
    return false;
  }
};

export const deleteSubmissionsBatch = async (submissionIds: string[]): Promise<boolean> => {
  try {
    if (submissionIds.length === 0) return true;
    // Resolve any legacy random-ID docs too
    const idSet = new Set(submissionIds.map(String));
    const actions: BatchAction[] = [];
    const seenPaths = new Set<string>();

    submissionIds.forEach((id) => {
      const directRef = doc(db, 'exam_submissions', String(id));
      actions.push({ type: 'delete', ref: directRef });
      seenPaths.add(directRef.path);
    });

    await commitActions(actions, 'exam_submissions');

    // Clean up any legacy random-doc-ID matches if still remaining
    try {
      const snap = await getDocs(getCollectionRef('submissions'));
      const legacyDeletes: BatchAction[] = [];
      snap.docs.forEach((d) => {
        const logicalId = String(d.data().id || d.id);
        if (idSet.has(logicalId) && !seenPaths.has(d.ref.path)) {
          legacyDeletes.push({ type: 'delete', ref: d.ref });
        }
      });
      if (legacyDeletes.length > 0) {
        await commitActions(legacyDeletes, 'exam_submissions');
      }
    } catch {}

    try {
      const pendingRaw = localStorage.getItem('pending_exam_submissions');
      if (pendingRaw) {
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

export const clearAllSubmissionsDirectly = async (courseId?: string): Promise<boolean> => {
  if (courseId) {
    return deleteDocsByCourse('submissions', courseId);
  }
  try {
    const ref = collection(db, 'exam_submissions');
    const snapshot = await getDocs(ref);
    const actions: BatchAction[] = snapshot.docs.map((d) => ({
      type: 'delete',
      ref: d.ref,
    }));
    await commitActions(actions, 'exam_submissions');
    try {
      localStorage.removeItem('pending_exam_submissions');
    } catch {}
    return true;
  } catch (err) {
    console.error('clearAllSubmissionsDirectly error:', err);
    return false;
  }
};

// Existing Google sign-in helpers kept for compatibility
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

export const getAccessToken = async (): Promise<string | null> => cachedAccessToken;

export const logoutGoogle = async () => {
  await auth.signOut();
  cachedAccessToken = null;
};
