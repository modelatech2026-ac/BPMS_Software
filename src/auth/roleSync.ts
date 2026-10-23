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
  REGISTERED_USERS_DB: 'bim_auth_registered_users_v1',
  TRACKER_CURRENT_USER: 'bim_tracker_current_user_v7',
};

/**
 * Deterministic document ID generator for access requests based on email
 */
export function generateRequestDocId(email: string): string {
  const clean = (email || '').trim().toLowerCase();
  const safeStr = clean.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
  const hash = Math.abs(
    clean.split('').reduce((acc, char) => (acc << 5) - acc + char.charCodeAt(0), 0)
  );
  return `req_${safeStr}_${hash}`;
}

function normalizeApprovalStatus(rawStatus: any): UserApprovalStatus {
  const s = String(rawStatus || 'Pending').trim().toLowerCase();
  if (s === 'approved' || s === 'active') return 'APPROVED';
  if (s === 'rejected' || s === 'declined' || s === 'suspended') return 'REJECTED';
  return 'PENDING';
}

/**
 * Fetch the user's assigned role and approval status from Firestore ('access_requests' and 'users').
 * Prioritizes approved records across both collections and never marks unknown users as approved.
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
      id: uid || generateRequestDocId(cleanEmail),
    };
  }

  const candidates: Array<DatabaseRoleResult & { updatedAtMs: number }> = [];
  const deterministicId = generateRequestDocId(cleanEmail);
  const docIdsToTry = Array.from(new Set([uid, deterministicId].filter(Boolean) as string[]));

  const parseTimestampMs = (data: any): number => {
    const raw = data?.updatedAt || data?.reviewedAt || data?.timestamp || data?.requestedAt || data?.createdAt;
    if (!raw) return 0;
    const ms = new Date(raw).getTime();
    return Number.isNaN(ms) ? 0 : ms;
  };

  // 2. Query Firestore 'access_requests' collection (direct deterministic doc lookup first)
  try {
    for (const dId of docIdsToTry) {
      const reqSnap = await getDoc(doc(db, 'access_requests', dId));
      if (reqSnap.exists()) {
        const rData = reqSnap.data();
        if ((rData?.email || '').trim().toLowerCase() === cleanEmail) {
          const rawRole = rData?.assignedRole || rData?.role || rData?.requestedRole;
          const role = normalizeUserRole(rawRole);
          const status = normalizeApprovalStatus(rData?.status);
          candidates.push({
            role,
            status,
            accessLevel: (rData?.assignedAccessLevel as AccessLevel) || mapAppRoleToAccessLevel(role),
            displayRole: mapAppRoleToDisplayRole(role),
            securityRole: mapUserRoleToSecurityRole(role),
            name: rData?.fullName || rData?.name,
            discipline: rData?.discipline || rData?.primaryDiscipline,
            source: 'database_access_requests',
            isApproved: status === 'APPROVED',
            id: reqSnap.id,
            updatedAtMs: parseTimestampMs(rData),
          });
        }
      }
    }

    if (!candidates.some((c) => c.isApproved)) {
      const reqsCol = collection(db, 'access_requests');
      const reqQ = query(reqsCol, where('email', '==', cleanEmail));
      const reqQuerySnap = await getDocs(reqQ);
      reqQuerySnap.docs.forEach((docSnap) => {
        const rData = docSnap.data();
        const rawRole = rData?.assignedRole || rData?.role || rData?.requestedRole;
        const role = normalizeUserRole(rawRole);
        const status = normalizeApprovalStatus(rData?.status);
        candidates.push({
          role,
          status,
          accessLevel: (rData?.assignedAccessLevel as AccessLevel) || mapAppRoleToAccessLevel(role),
          displayRole: mapAppRoleToDisplayRole(role),
          securityRole: mapUserRoleToSecurityRole(role),
          name: rData?.fullName || rData?.name,
          discipline: rData?.discipline || rData?.primaryDiscipline,
          source: 'database_access_requests',
          isApproved: status === 'APPROVED',
          id: docSnap.id,
          updatedAtMs: parseTimestampMs(rData),
        });
      });
    }
  } catch (err) {
    console.warn('Firestore access_requests collection lookup notice:', err);
  }

  // 3. Query Firestore 'users' collection (only if not already confirmed approved)
  if (!candidates.some((c) => c.isApproved)) {
    try {
      for (const dId of docIdsToTry) {
        const userSnap = await getDoc(doc(db, 'users', dId));
        if (userSnap.exists()) {
          const uData = userSnap.data();
          if ((uData?.email || '').trim().toLowerCase() === cleanEmail) {
            const rawRole = uData?.role || uData?.appRole || uData?.assignedRole;
            if (rawRole) {
              const role = normalizeUserRole(rawRole);
              const status = normalizeApprovalStatus(uData?.status || 'APPROVED');
              candidates.push({
                role,
                status,
                accessLevel: (uData?.accessLevel as AccessLevel) || mapAppRoleToAccessLevel(role),
                displayRole: mapAppRoleToDisplayRole(role),
                securityRole: mapUserRoleToSecurityRole(role),
                name: uData?.name,
                discipline: uData?.discipline,
                source: 'database_users',
                isApproved: status === 'APPROVED',
                id: userSnap.id,
                updatedAtMs: parseTimestampMs(uData),
              });
            }
          }
        }
      }

      if (!candidates.some((c) => c.isApproved)) {
        const usersCol = collection(db, 'users');
        const userQ = query(usersCol, where('email', '==', cleanEmail));
        const userQuerySnap = await getDocs(userQ);
        userQuerySnap.docs.forEach((docSnap) => {
          const uData = docSnap.data();
          const rawRole = uData?.role || uData?.appRole || uData?.assignedRole;
          if (rawRole) {
            const role = normalizeUserRole(rawRole);
            const status = normalizeApprovalStatus(uData?.status || 'APPROVED');
            candidates.push({
              role,
              status,
              accessLevel: (uData?.accessLevel as AccessLevel) || mapAppRoleToAccessLevel(role),
              displayRole: mapAppRoleToDisplayRole(role),
              securityRole: mapUserRoleToSecurityRole(role),
              name: uData?.name,
              discipline: uData?.discipline,
              source: 'database_users',
              isApproved: status === 'APPROVED',
              id: docSnap.id,
              updatedAtMs: parseTimestampMs(uData),
            });
          }
        });
      }
    } catch (err) {
      console.warn('Firestore users collection lookup notice:', err);
    }
  }

  if (candidates.length > 0) {
    // Sort candidates: APPROVED first, then REJECTED, then PENDING; break ties by newest timestamp
    const statusWeight = (s: UserApprovalStatus) => (s === 'APPROVED' ? 3 : s === 'REJECTED' ? 2 : 1);
    candidates.sort((a, b) => {
      const wDiff = statusWeight(b.status) - statusWeight(a.status);
      if (wDiff !== 0) return wDiff;
      return b.updatedAtMs - a.updatedAtMs;
    });
    const best = candidates[0];
    return {
      role: best.role,
      status: best.status,
      accessLevel: best.accessLevel,
      displayRole: best.displayRole,
      securityRole: best.securityRole,
      name: best.name,
      discipline: best.discipline,
      source: best.source,
      isApproved: best.isApproved,
      id: best.id,
    };
  }

  // 4. Default fallback for completely unknown user (not yet in Firestore)
  return {
    role: 'EDITOR',
    status: 'PENDING',
    accessLevel: 'Editor',
    displayRole: 'BIM Modeler / Editor',
    securityRole: 'BIM Specialist',
    source: 'default',
    isApproved: false,
    id: deterministicId,
  };
}

/**
 * Persists the user's assigned role and approval status to both Firestore collections
 * ('access_requests' and 'users') and local session caches.
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

  const validatedRole: UserRole = normalizeUserRole(params.role, isSuperAdminEmail(cleanEmail));
  const calculatedAccessLevel: AccessLevel =
    params.accessLevel || mapAppRoleToAccessLevel(validatedRole);
  const normalizedStatus: UserApprovalStatus = normalizeApprovalStatus(params.status || 'APPROVED');
  const firestoreRequestStatus =
    normalizedStatus === 'APPROVED'
      ? 'Approved'
      : normalizedStatus === 'REJECTED'
      ? 'Rejected'
      : 'Pending';
  const displayRole = mapAppRoleToDisplayRole(validatedRole);
  const nowIso = new Date().toISOString();
  const deterministicId = generateRequestDocId(cleanEmail);
  const targetId = params.uid || deterministicId;

  const updatePayload = {
    email: cleanEmail,
    name: params.name || cleanEmail.split('@')[0],
    fullName: params.name || cleanEmail.split('@')[0],
    role: validatedRole,
    assignedRole: validatedRole,
    requestedRole: displayRole,
    assignedAccessLevel: calculatedAccessLevel,
    status: firestoreRequestStatus,
    reviewedBy: params.reviewedBy || `${SUPER_ADMIN_NAME} (Super Admin)`,
    reviewedAt: nowIso,
    updatedAt: nowIso,
  };

  // 1. Update matching records in Firestore 'access_requests'
  try {
    const reqsCol = collection(db, 'access_requests');
    const reqQ = query(reqsCol, where('email', '==', cleanEmail));
    const snap = await getDocs(reqQ);

    const updatedDocIds = new Set<string>();
    if (!snap.empty) {
      const updatePromises = snap.docs.map((docSnap) => {
        updatedDocIds.add(docSnap.id);
        return setDoc(docSnap.ref, updatePayload, { merge: true });
      });
      await Promise.all(updatePromises);
    }

    if (!updatedDocIds.has(targetId)) {
      await setDoc(
        doc(db, 'access_requests', targetId),
        {
          id: targetId,
          uid: targetId,
          discipline: params.discipline || 'BIM - ACS',
          primaryDiscipline: params.discipline || 'BIM - ACS',
          createdAt: nowIso,
          timestamp: nowIso,
          ...updatePayload,
        },
        { merge: true }
      );
      updatedDocIds.add(targetId);
    }

    if (!updatedDocIds.has(deterministicId)) {
      await setDoc(
        doc(db, 'access_requests', deterministicId),
        {
          id: deterministicId,
          uid: deterministicId,
          discipline: params.discipline || 'BIM - ACS',
          primaryDiscipline: params.discipline || 'BIM - ACS',
          createdAt: nowIso,
          timestamp: nowIso,
          ...updatePayload,
        },
        { merge: true }
      );
    }
  } catch (err) {
    console.error('Firestore access_requests persistence error:', err);
    throw err;
  }

  // 2. Update Firestore 'users' collection
  try {
    const userPayload = {
      id: targetId,
      email: cleanEmail,
      name: params.name || cleanEmail.split('@')[0],
      role: validatedRole,
      appRole: validatedRole,
      status: normalizedStatus,
      accessLevel: calculatedAccessLevel,
      discipline: params.discipline || 'BIM - ACS',
      updatedAt: nowIso,
    };
    await setDoc(doc(db, 'users', targetId), userPayload, { merge: true });
    if (deterministicId !== targetId) {
      await setDoc(
        doc(db, 'users', deterministicId),
        { ...userPayload, id: deterministicId },
        { merge: true }
      );
    }
  } catch (err) {
    console.error('Firestore users collection persistence error:', err);
    throw err;
  }

  // 3. Update saved users database in localStorage
  try {
    for (const dbKey of [STORAGE_KEYS.SAVED_USERS_DB, STORAGE_KEYS.REGISTERED_USERS_DB]) {
      const saved = localStorage.getItem(dbKey);
      let usersDb: Record<string, AuthUser> = {};
      if (saved) {
        usersDb = JSON.parse(saved);
      }
      const existing = usersDb[cleanEmail];
      usersDb[cleanEmail] = {
        ...(existing || {}),
        id: existing?.id || targetId,
        googleId: existing?.googleId || targetId,
        email: cleanEmail,
        name: params.name || existing?.name || cleanEmail.split('@')[0],
        role: displayRole,
        appRole: validatedRole,
        accessLevel: calculatedAccessLevel,
        securityRole: mapUserRoleToSecurityRole(validatedRole),
        status: normalizedStatus,
        isAdmin: validatedRole === 'SUPER_ADMIN' || validatedRole === 'DIRECTOR' || validatedRole === 'PROJECT_MANAGER',
        requestTimestamp: existing?.requestTimestamp || nowIso,
      };
      localStorage.setItem(dbKey, JSON.stringify(usersDb));
    }
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
          status: normalizedStatus,
          isAdmin: validatedRole === 'SUPER_ADMIN' || validatedRole === 'DIRECTOR' || validatedRole === 'PROJECT_MANAGER',
        };
        localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(updatedCur));
        localStorage.setItem(STORAGE_KEYS.TRACKER_CURRENT_USER, JSON.stringify(updatedCur));
      }
    }
  } catch (e) {
    console.warn('Current user storage update notice:', e);
  }
}
