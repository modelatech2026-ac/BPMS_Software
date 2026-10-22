/**
 * BPMS Role Synchronization & Database Persistence Engine
 * 
 * Ensures roles assigned through Admin Nexus persist across logins, sessions, and page reloads.
 * Fetches and preserves user roles from Firestore collections ('users' and 'access_requests').
 * Enforces strict non-overwriting guarantees for SUPER_ADMIN, PROJECT_MANAGER, EDITOR, and VIEWER.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import { UserRole, UserApprovalStatus, AccessLevel, SecurityRole, AuthUser } from '../types';
import {
  isSuperAdminEmail,
  normalizeUserRole,
  mapAppRoleToAccessLevel,
  mapAppRoleToDisplayRole,
  mapUserRoleToSecurityRole,
  SUPER_ADMIN_EMAIL,
  SUPER_ADMIN_NAME,
} from './googleAuth';

export interface DatabaseRoleResult {
  role: UserRole;
  status: UserApprovalStatus;
  accessLevel: AccessLevel;
  displayRole: string;
  securityRole: SecurityRole;
  name?: string;
  discipline?: string;
  source: 'super_admin' | 'database_users' | 'database_access_requests' | 'local_db' | 'default';
  isApproved: boolean;
  id?: string;
}

const STORAGE_KEYS = {
  CURRENT_USER: 'bim_auth_user_central_v1',
  SAVED_USERS_DB: 'bim_auth_users_db_v1',
  TRACKER_CURRENT_USER: 'bim_tracker_current_user_v7',
};

/**
 * Deterministic document ID generator for access requests based on email
 */
export function generateRequestDocId(email: string): string {
  const clean = email.trim().toLowerCase();
  const safeStr = clean.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
  const hash = Math.abs(
    clean.split('').reduce((acc, char) => (acc << 5) - acc + char.charCodeAt(0), 0)
  );
  return `req_${safeStr}_${hash}`;
}

/**
 * Fetch the user's assigned role from the database ('users' or 'access_requests').
 * Never defaults or overwrites with EDITOR if a record exists.
 */
export async function fetchUserRoleFromDatabase(
  rawEmail: string,
  uid?: string
): Promise<DatabaseRoleResult> {
  const cleanEmail = (rawEmail || '').trim().toLowerCase();

  // 1. Super Admin check: always full SUPER_ADMIN access
  if (isSuperAdminEmail(cleanEmail)) {
    return {
      role: 'SUPER_ADMIN',
      status: 'APPROVED',
      accessLevel: 'Super Admin',
      displayRole: 'Super Administrator & Lead Architect',
      securityRole: 'Super Admin',
      source: 'super_admin',
      isApproved: true,
      id: uid || 'usr_super_admin_sushoovan',
    };
  }

  // 2. Query Firestore 'users' collection first (authoritative user accounts)
  try {
    // A. Check by provided uid
    if (uid) {
      const userDocRef = doc(db, 'users', uid);
      const userSnap = await getDoc(userDocRef);
      if (userSnap.exists()) {
        const uData = userSnap.data();
        const rawRole = uData?.role || uData?.appRole || uData?.assignedRole;
        if (rawRole) {
          const role = normalizeUserRole(rawRole);
          const rawStatus = (uData?.status || 'APPROVED').toLowerCase();
          const status: UserApprovalStatus =
            rawStatus === 'approved' ? 'APPROVED' : rawStatus === 'rejected' ? 'REJECTED' : 'pending';
          return {
            role,
            status,
            accessLevel: (uData?.accessLevel as AccessLevel) || mapAppRoleToAccessLevel(role),
            displayRole: mapAppRoleToDisplayRole(role),
            securityRole: mapUserRoleToSecurityRole(role),
            name: uData?.name,
            discipline: uData?.discipline,
            source: 'database_users',
            isApproved: status === 'APPROVED',
            id: uid,
          };
        }
      }
    }

    // B. Query 'users' by email
    const usersCol = collection(db, 'users');
    const userQ = query(usersCol, where('email', '==', cleanEmail));
    const userQuerySnap = await getDocs(userQ);
    if (!userQuerySnap.empty) {
      const uData = userQuerySnap.docs[0].data();
      const rawRole = uData?.role || uData?.appRole || uData?.assignedRole;
      if (rawRole) {
        const role = normalizeUserRole(rawRole);
        const rawStatus = (uData?.status || 'APPROVED').toLowerCase();
        const status: UserApprovalStatus =
          rawStatus === 'approved' ? 'APPROVED' : rawStatus === 'rejected' ? 'REJECTED' : 'pending';
        return {
          role,
          status,
          accessLevel: (uData?.accessLevel as AccessLevel) || mapAppRoleToAccessLevel(role),
          displayRole: mapAppRoleToDisplayRole(role),
          securityRole: mapUserRoleToSecurityRole(role),
          name: uData?.name,
          discipline: uData?.discipline,
          source: 'database_users',
          isApproved: status === 'APPROVED',
          id: userQuerySnap.docs[0].id,
        };
      }
    }
  } catch (err) {
    console.warn('Firestore users collection lookup notice:', err);
  }

  // 3. Query Firestore 'access_requests' collection
  try {
    // A. Try direct doc lookup by generated UID or provided uid
    const docIdsToTry: string[] = [];
    if (uid) docIdsToTry.push(uid);
    const genId = generateRequestDocId(cleanEmail);
    if (!docIdsToTry.includes(genId)) docIdsToTry.push(genId);

    for (const dId of docIdsToTry) {
      const reqDocRef = doc(db, 'access_requests', dId);
      const reqSnap = await getDoc(reqDocRef);
      if (reqSnap.exists()) {
        const rData = reqSnap.data();
        const rawRole = rData?.assignedRole || rData?.role || rData?.requestedRole;
        const rawStatus = (rData?.status || 'pending').toLowerCase();
        const status: UserApprovalStatus =
          rawStatus === 'approved' ? 'APPROVED' : rawStatus === 'rejected' ? 'REJECTED' : 'pending';
        const role = normalizeUserRole(rawRole);
        return {
          role,
          status,
          accessLevel: (rData?.assignedAccessLevel as AccessLevel) || mapAppRoleToAccessLevel(role),
          displayRole: mapAppRoleToDisplayRole(role),
          securityRole: mapUserRoleToSecurityRole(role),
          name: rData?.fullName || rData?.name,
          discipline: rData?.discipline || rData?.primaryDiscipline,
          source: 'database_access_requests',
          isApproved: status === 'APPROVED',
          id: dId,
        };
      }
    }

    // B. Query 'access_requests' by email field
    const reqsCol = collection(db, 'access_requests');
    const reqQ = query(reqsCol, where('email', '==', cleanEmail));
    const reqQuerySnap = await getDocs(reqQ);
    if (!reqQuerySnap.empty) {
      const rData = reqQuerySnap.docs[0].data();
      const rawRole = rData?.assignedRole || rData?.role || rData?.requestedRole;
      const rawStatus = (rData?.status || 'pending').toLowerCase();
      const status: UserApprovalStatus =
        rawStatus === 'approved' ? 'APPROVED' : rawStatus === 'rejected' ? 'REJECTED' : 'pending';
      const role = normalizeUserRole(rawRole);
      return {
        role,
        status,
        accessLevel: (rData?.assignedAccessLevel as AccessLevel) || mapAppRoleToAccessLevel(role),
        displayRole: mapAppRoleToDisplayRole(role),
        securityRole: mapUserRoleToSecurityRole(role),
        name: rData?.fullName || rData?.name,
        discipline: rData?.discipline || rData?.primaryDiscipline,
        source: 'database_access_requests',
        isApproved: status === 'APPROVED',
        id: reqQuerySnap.docs[0].id,
      };
    }
  } catch (err) {
    console.warn('Firestore access_requests collection lookup notice:', err);
  }

  // 4. Local fallback: Check saved users db in localStorage
  try {
    const savedDb = localStorage.getItem(STORAGE_KEYS.SAVED_USERS_DB);
    if (savedDb) {
      const parsed = JSON.parse(savedDb);
      if (parsed && parsed[cleanEmail]) {
        const localUser: AuthUser = parsed[cleanEmail];
        const role = normalizeUserRole(localUser.appRole || localUser.role);
        return {
          role,
          status: localUser.status || 'APPROVED',
          accessLevel: localUser.accessLevel || mapAppRoleToAccessLevel(role),
          displayRole: mapAppRoleToDisplayRole(role),
          securityRole: mapUserRoleToSecurityRole(role),
          name: localUser.name,
          source: 'local_db',
          isApproved: localUser.status === 'APPROVED',
          id: localUser.googleId || localUser.id,
        };
      }
    }
  } catch (e) {
    console.warn('LocalStorage role check notice:', e);
  }

  // 5. Default fallback for completely unrecorded user
  return {
    role: 'EDITOR',
    status: 'pending',
    accessLevel: 'Editor',
    displayRole: 'BIM Modeler / Editor',
    securityRole: 'BIM Specialist',
    source: 'default',
    isApproved: false,
    id: uid || generateRequestDocId(cleanEmail),
  };
}

/**
 * Persists the user's assigned role to both Firestore collections ('access_requests' and 'users')
 * and local session caches. Never overwrites with default role.
 */
export async function persistUserRoleToDatabase(params: {
  email: string;
  role: UserRole;
  status?: UserApprovalStatus;
  accessLevel?: AccessLevel;
  name?: string;
  discipline?: string;
  uid?: string;
  reviewedBy?: string;
}): Promise<void> {
  const cleanEmail = params.email.trim().toLowerCase();
  if (!cleanEmail) return;

  const validatedRole: UserRole = normalizeUserRole(params.role);
  const calculatedAccessLevel: AccessLevel =
    params.accessLevel || mapAppRoleToAccessLevel(validatedRole);
  const status: UserApprovalStatus = params.status || 'APPROVED';
  const displayRole = mapAppRoleToDisplayRole(validatedRole);
  const nowIso = new Date().toISOString();

  // 1. Update matching records in Firestore 'access_requests'
  try {
    const reqsCol = collection(db, 'access_requests');
    const reqQ = query(reqsCol, where('email', '==', cleanEmail));
    const snap = await getDocs(reqQ);

    const updatePayload = {
      role: validatedRole,
      assignedRole: validatedRole,
      assignedAccessLevel: calculatedAccessLevel,
      status: status.toLowerCase(),
      reviewedBy: params.reviewedBy || `${SUPER_ADMIN_NAME} (Super Admin)`,
      reviewedAt: nowIso,
      updatedAt: nowIso,
    };

    if (!snap.empty) {
      const updatePromises = snap.docs.map((docSnap) =>
        updateDoc(docSnap.ref, updatePayload).catch((e) =>
          console.warn('access_requests update error for', docSnap.id, e)
        )
      );
      await Promise.all(updatePromises);
    } else {
      // If doc didn't exist by query, create/update via generated id or uid
      const targetId = params.uid || generateRequestDocId(cleanEmail);
      await setDoc(
        doc(db, 'access_requests', targetId),
        {
          id: targetId,
          email: cleanEmail,
          name: params.name || cleanEmail.split('@')[0],
          fullName: params.name || cleanEmail.split('@')[0],
          discipline: params.discipline || 'BIM - ACS',
          createdAt: nowIso,
          ...updatePayload,
        },
        { merge: true }
      );
    }
  } catch (err) {
    console.warn('Firestore access_requests persistence notice:', err);
  }

  // 2. Update Firestore 'users' collection
  try {
    const userDocId = params.uid || generateRequestDocId(cleanEmail);
    await setDoc(
      doc(db, 'users', userDocId),
      {
        id: userDocId,
        email: cleanEmail,
        name: params.name || cleanEmail.split('@')[0],
        role: validatedRole,
        appRole: validatedRole,
        status: status,
        accessLevel: calculatedAccessLevel,
        discipline: params.discipline || 'BIM - ACS',
        updatedAt: nowIso,
      },
      { merge: true }
    );
  } catch (err) {
    console.warn('Firestore users collection persistence notice:', err);
  }

  // 3. Update saved users database in localStorage
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.SAVED_USERS_DB);
    let usersDb: Record<string, AuthUser> = {};
    if (saved) {
      usersDb = JSON.parse(saved);
    }
    const existing = usersDb[cleanEmail];
    usersDb[cleanEmail] = {
      ...(existing || {}),
      id: existing?.id || params.uid || generateRequestDocId(cleanEmail),
      email: cleanEmail,
      name: params.name || existing?.name || cleanEmail.split('@')[0],
      role: displayRole,
      appRole: validatedRole,
      accessLevel: calculatedAccessLevel,
      securityRole: mapUserRoleToSecurityRole(validatedRole),
      status: status,
      isAdmin: validatedRole === 'SUPER_ADMIN' || validatedRole === 'PROJECT_MANAGER',
      requestTimestamp: existing?.requestTimestamp || nowIso,
    };
    localStorage.setItem(STORAGE_KEYS.SAVED_USERS_DB, JSON.stringify(usersDb));
  } catch (e) {
    console.warn('LocalStorage usersDb persistence notice:', e);
  }

  // 4. If current logged in user is this user, update current user cache in localStorage
  try {
    const curRaw = localStorage.getItem(STORAGE_KEYS.CURRENT_USER);
    if (curRaw) {
      const cur = JSON.parse(curRaw);
      if (cur?.email?.toLowerCase() === cleanEmail) {
        const updatedCur: AuthUser = {
          ...cur,
          role: displayRole,
          appRole: validatedRole,
          accessLevel: calculatedAccessLevel,
          securityRole: mapUserRoleToSecurityRole(validatedRole),
          status: status,
          isAdmin: validatedRole === 'SUPER_ADMIN' || validatedRole === 'PROJECT_MANAGER',
        };
        localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(updatedCur));
        localStorage.setItem(STORAGE_KEYS.TRACKER_CURRENT_USER, JSON.stringify(updatedCur));
      }
    }
  } catch (e) {
    console.warn('Current user storage update notice:', e);
  }
}
