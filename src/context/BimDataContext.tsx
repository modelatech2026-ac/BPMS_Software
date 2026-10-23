import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import {
  BimProject,
  Employee,
  DailyWorkLog,
  GeneratedStakeholderReport,
  ViewTab,
  Discipline,
  ActivityType,
  LODLevel,
  Milestone,
  ClashRecord,
  TaskItem,
  ThemeMode,
  AuthUser,
  OnboardingRequest,
  UserApprovalStatus,
  AccessLevel,
  AdminAuditLog,
  UserRole,
  ResourceAllocationItem,
} from '../types';
import {
  INITIAL_PROJECTS,
  INITIAL_EMPLOYEES,
  generateInitialWorkLogs,
} from '../data/mockData';
import {
  SUPER_ADMIN_EMAIL,
  SUPER_ADMIN_NAME,
  isSuperAdminEmail,
  mapAppRoleToAccessLevel,
  mapAppRoleToDisplayRole,
  normalizeUserRole,
} from '../auth/googleAuth';
import {
  persistUserRoleToDatabase,
  fetchUserRoleFromDatabase,
  generateRequestDocId,
  DatabaseRoleResult,
} from '../auth/roleSync';
import { useOptionalAuth } from '../auth/AuthContext';
import { db } from '../firebase/config';
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  updateDoc,
  setDoc,
  getDocs,
  getDoc,
  deleteDoc,
  query,
  where,
  or,
  serverTimestamp,
} from 'firebase/firestore';

interface BimDataContextType {
  projects: BimProject[];
  employees: Employee[];
  workLogs: DailyWorkLog[];
  generatedReports: GeneratedStakeholderReport[];
  savedReports?: GeneratedStakeholderReport[];
  selectedProjectId: string;
  setSelectedProjectId: (id: string) => void;
  currentTab: ViewTab;
  setCurrentTab: (tab: ViewTab) => void;
  dateFilter: string; // 'all' | 'today' | 'this-week' | 'this-month'
  setDateFilter: (filter: string) => void;
  globalSearchQuery: string;
  setGlobalSearchQuery: (query: string) => void;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;

  // Authentication & Onboarding Workflow (Phase 1)
  currentUser: AuthUser | null;
  setCurrentUser: (user: AuthUser | null) => void;
  onboardingRequests: OnboardingRequest[];
  setOnboardingRequests: React.Dispatch<React.SetStateAction<OnboardingRequest[]>>;
  registerAccessRequest: (params: {
    name: string;
    email: string;
    fullName?: string;
    discipline?: string;
    reasonForAccess?: string;
    uid?: string;
    organization?: string;
    accessReason?: string;
    existingDbRecord?: DatabaseRoleResult;
    skipFirestoreWrite?: boolean;
  }) => Promise<OnboardingRequest>;
  auditLogs: AdminAuditLog[];
  setAuditLogs: React.Dispatch<React.SetStateAction<AdminAuditLog[]>>;
  addAuditLog: (log: Omit<AdminAuditLog, 'id' | 'timestamp'>) => void;
  signInWithGoogle: (profile: {
    googleId?: string;
    email: string;
    name?: string;
    picture?: string;
    organization?: string;
    discipline?: string;
    accessReason?: string;
  }) => { status: UserApprovalStatus; user: AuthUser };
  signInWithEmail: (email: string, name?: string) => { status: UserApprovalStatus; user: AuthUser };
  requestAccess: (params: {
    name: string;
    email: string;
    requestedRole: string;
    primaryDiscipline: Discipline;
    organization?: string;
    accessReason?: string;
  }) => { status: UserApprovalStatus; user: AuthUser };
  updateAccessRequestReason: (requestId: string, accessReason: string, organization?: string) => void;
  checkUserStatus: () => void;
  approveOnboardingRequest: (
    requestId: string,
    assignedRole?: UserRole | string,
    assignedAccessLevel?: AccessLevel,
    assignedDiscipline?: Discipline | string
  ) => void;
  rejectOnboardingRequest: (requestId: string, notes?: string) => void;
  reopenOnboardingRequest: (requestId: string) => void;
  deleteOnboardingRequest: (requestId: string) => void;
  setSimulatedAuthStatus: (status: UserApprovalStatus) => void;
  switchUser: (user: Partial<AuthUser>) => void;
  signOut: () => void;

  // Actions
  addProject: (project: Omit<BimProject, 'id'>) => BimProject;
  updateProject: (id: string, updates: Partial<BimProject>) => void;
  updateProjectStatus: (id: string, status: BimProject['status']) => void;
  deleteProject: (id: string) => void;

  addWorkLog: (log: Omit<DailyWorkLog, 'id' | 'timestamp'>) => DailyWorkLog;
  updateWorkLog: (id: string, updates: Partial<DailyWorkLog>) => void;
  deleteWorkLog: (id: string) => void;

  addEmployee: (emp: Omit<Employee, 'id'>) => Employee;
  updateEmployee: (id: string, updates: Partial<Employee>) => void;
  deleteEmployee: (id: string) => void;

  addMilestone: (projectId: string, milestone: Omit<Milestone, 'id'>) => void;
  updateMilestoneStatus: (
    projectId: string,
    milestoneId: string,
    status: Milestone['status']
  ) => void;

  addClash: (projectId: string, clash: Omit<ClashRecord, 'id'>) => void;
  updateClashStatus: (
    projectId: string,
    clashId: string,
    status: ClashRecord['status']
  ) => void;

  addTask: (projectId: string, task: Omit<TaskItem, 'id' | 'projectId'>) => void;
  updateTask: (projectId: string, taskId: string, updates: Partial<TaskItem>) => void;

  saveStakeholderReport: (report: GeneratedStakeholderReport) => void;
  resetToMockData: () => void;

  // Aggregated Analytics
  getProjectById: (id: string) => BimProject | undefined;
  getEmployeeById: (id: string) => Employee | undefined;
  getProjectCompletedHours: (projectId: string) => number;
  getEmployeeLoggedHours: (employeeId: string, filterRange?: string) => number;
  overallMetrics: {
    totalEstimatedHours: number;
    totalCompletedHours: number;
    hoursVariance: number;
    completionPercentage: number;
    activeProjectsCount: number;
    totalEmployeesCount: number;
    criticalClashesCount: number;
    totalClashesCount: number;
    resolvedClashesCount: number;
    avgUtilizationRate: number;
  };
}

const BimDataContext = createContext<BimDataContextType | undefined>(undefined);

const STORAGE_KEYS = {
  PROJECTS: 'bim_tracker_projects_v7',
  EMPLOYEES: 'bim_tracker_employees_v7',
  WORK_LOGS: 'bim_tracker_worklogs_v7',
  REPORTS: 'bim_tracker_reports_v7',
  USER_ACCESS: 'bim_tracker_user_access_v7',
  THEME: 'bim_tracker_theme_v7',
  CURRENT_USER: 'bim_tracker_current_user_v7',
  ONBOARDING: 'bim_tracker_onboarding_v7',
  AUDIT_LOGS: 'bim_tracker_audit_logs_v7',
};

// Purge legacy storage caches on boot
if (typeof window !== 'undefined') {
  try {
    const legacyKeys = [
      'bim_tracker_projects_v1', 'bim_tracker_projects_v2', 'bim_tracker_projects_v3', 'bim_tracker_projects_v4', 'bim_tracker_projects_v5', 'bim_tracker_projects_v6',
      'bim_tracker_employees_v1', 'bim_tracker_employees_v2', 'bim_tracker_employees_v3', 'bim_tracker_employees_v4', 'bim_tracker_employees_v5', 'bim_tracker_employees_v6',
      'bim_tracker_worklogs_v1', 'bim_tracker_worklogs_v2', 'bim_tracker_worklogs_v3', 'bim_tracker_worklogs_v4', 'bim_tracker_worklogs_v5', 'bim_tracker_worklogs_v6',
      'bim_projects_v2', 'bim_employees_v2', 'bim_work_logs_v2',
      'bim_resource_allocations_v1', 'bim_project_feedbacks_v1'
    ];
    legacyKeys.forEach((k) => localStorage.removeItem(k));
  } catch {}
}

const DEFAULT_CURRENT_USER: AuthUser = {
  id: 'usr_super_admin_modelatech',
  googleId: 'google_super_admin_modelatech',
  email: SUPER_ADMIN_EMAIL,
  name: SUPER_ADMIN_NAME,
  role: 'Super Administrator & Lead Architect',
  appRole: 'SUPER_ADMIN',
  status: 'APPROVED',
  isAdmin: true,
  accessLevel: 'Super Admin',
  organization: 'BPMS Core Systems & Architecture',
  accessReason: 'Executive Super Administrator with master editing and governance access',
  requestTimestamp: '2026-08-23 09:00 AM',
  avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=250',
};

const DEFAULT_ONBOARDING_REQUESTS: OnboardingRequest[] = [];

const DEFAULT_AUDIT_LOGS: AdminAuditLog[] = [
  {
    id: 'audit-1',
    action: 'approved',
    targetUserEmail: SUPER_ADMIN_EMAIL,
    targetUserName: SUPER_ADMIN_NAME,
    performedBy: 'System Bootstrap',
    timestamp: '2026-08-23 09:00 AM',
    details: 'Provisioned Super Admin credentials and master administrative privileges.',
  },
];

export interface WeekDayColumn {
  date: string;
  label: string;
  dayNum: string;
}

export interface WeekRangeResult {
  startDate: Date;
  endDate: Date;
  startIso: string;
  endIso: string;
  label: string;
  days: WeekDayColumn[];
}

export const toLocalIsoDate = (d: Date): string => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const getCurrentWeekRange = (referenceDate: Date = new Date()): WeekRangeResult => {
  const now = new Date(referenceDate);
  const dayOfWeek = now.getDay(); // 0 (Sun) - 6 (Sat)
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() + diffToMonday);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const todayIso = toLocalIsoDate(new Date());
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const days: WeekDayColumn[] = Array.from({ length: 7 }, (_, idx) => {
    const cur = new Date(monday);
    cur.setDate(monday.getDate() + idx);
    const iso = toLocalIsoDate(cur);
    const dayNum = String(cur.getDate()).padStart(2, '0');
    return {
      date: iso,
      label: iso === todayIso ? `${dayNames[idx]} (Today)` : dayNames[idx],
      dayNum,
    };
  });

  const startFormatted = monday.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  const endFormatted = sunday.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return {
    startDate: monday,
    endDate: sunday,
    startIso: toLocalIsoDate(monday),
    endIso: toLocalIsoDate(sunday),
    label: `${startFormatted} - ${endFormatted}`,
    days,
  };
};

export const getEffectiveLogDate = (
  log: DailyWorkLog,
  weekRange: WeekRangeResult = getCurrentWeekRange()
): string => {
  const rawDate = (log.date || '').trim();
  if (rawDate >= weekRange.startIso && rawDate <= weekRange.endIso) {
    return rawDate;
  }
  if ((!rawDate || rawDate === '2026-08-18') && log.timestamp) {
    const tsDate = new Date(log.timestamp);
    if (!Number.isNaN(tsDate.getTime())) {
      const tsIso = toLocalIsoDate(tsDate);
      if (tsIso >= weekRange.startIso && tsIso <= weekRange.endIso) {
        return tsIso;
      }
    }
  }
  return rawDate;
};

export const isUserSuperAdmin = (u: AuthUser | null | undefined): boolean => {
  if (!u) return false;
  if (
    u.securityRole === 'Super Admin' ||
    u.securityRole === 'Director' ||
    u.appRole === 'SUPER_ADMIN' ||
    u.appRole === 'DIRECTOR' ||
    u.accessLevel === 'Super Admin' ||
    u.accessLevel === 'Director' ||
    u.role === 'Super Admin' ||
    u.role === 'Director'
  ) {
    return true;
  }
  // If user has an explicitly assigned non-admin role (e.g., switched role or standard user), respect it
  if (
    u.securityRole === 'Project Manager' ||
    u.securityRole === 'BIM Specialist' ||
    u.securityRole === 'Lead Coordinator' ||
    u.securityRole === 'Editor' ||
    u.securityRole === 'Viewer' ||
    u.appRole === 'PROJECT_MANAGER' ||
    u.appRole === 'EDITOR' ||
    u.appRole === 'VIEWER'
  ) {
    return false;
  }
  const email = (u.email || '').trim().toLowerCase();
  if (isSuperAdminEmail(email)) return true;
  if (u.appRole && (normalizeUserRole(u.appRole) === 'SUPER_ADMIN' || normalizeUserRole(u.appRole) === 'DIRECTOR')) return true;
  if (u.isAdmin && (u.role?.toLowerCase().includes('admin') || u.role?.toLowerCase().includes('director'))) return true;
  return false;
};

export const isRecordOwnedByMember = (
  log: DailyWorkLog,
  user: AuthUser | null | undefined,
  allEmployees: Employee[]
): boolean => {
  if (!user) return false;
  const userEmail = (user.email || '').trim().toLowerCase();
  const userId = (user.id || '').trim();
  const userIdStripped = userId.replace(/^emp-/, '');
  const userGoogleId = (user.googleId || '').trim();
  const detEmailId = userEmail ? generateRequestDocId(userEmail) : '';
  const logEmpId = (log.employeeId || '').trim();
  const logEmpIdStripped = logEmpId.replace(/^emp-/, '');
  const logUserId = ((log as any).userId || '').trim();
  const logUserIdStripped = logUserId.replace(/^emp-/, '');

  // 1. Direct email match
  if (userEmail) {
    if (log.memberEmail && log.memberEmail.trim().toLowerCase() === userEmail) return true;
    if ((log as any).userEmail && (log as any).userEmail.trim().toLowerCase() === userEmail) return true;
  }

  // 2. Direct user ID / deterministic ID match
  const candidateIds = new Set(
    [userId, userIdStripped, userGoogleId, detEmailId].filter(Boolean)
  );
  if (
    (logEmpId && candidateIds.has(logEmpId)) ||
    (logEmpIdStripped && candidateIds.has(logEmpIdStripped)) ||
    (logUserId && candidateIds.has(logUserId)) ||
    (logUserIdStripped && candidateIds.has(logUserIdStripped))
  ) {
    return true;
  }

  // 3. Direct name match if user has a name
  if (
    user.name &&
    log.employeeName &&
    log.employeeName.trim().toLowerCase() === user.name.trim().toLowerCase()
  ) {
    return true;
  }

  // 4. Employee mapping match
  const matchingEmp = allEmployees.find(
    (e) =>
      e.id === userId ||
      e.id.replace(/^emp-/, '') === userIdStripped ||
      (detEmailId && e.id.replace(/^emp-/, '') === detEmailId) ||
      (e.email && userEmail && e.email.trim().toLowerCase() === userEmail) ||
      (e.name && user.name && e.name.trim().toLowerCase() === user.name.trim().toLowerCase())
  );
  if (matchingEmp) {
    const matchEmpIdStripped = matchingEmp.id.replace(/^emp-/, '');
    if (
      logEmpId === matchingEmp.id ||
      logEmpIdStripped === matchEmpIdStripped ||
      logUserId === matchingEmp.id ||
      logUserIdStripped === matchEmpIdStripped
    ) {
      return true;
    }
    if (
      log.employeeName &&
      matchingEmp.name &&
      log.employeeName.trim().toLowerCase() === matchingEmp.name.trim().toLowerCase()
    ) {
      return true;
    }
  }

  return false;
};

export const BimDataProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [projects, setProjects] = useState<BimProject[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.PROJECTS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {}
    return INITIAL_PROJECTS;
  });

  const [employees, setEmployees] = useState<Employee[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.EMPLOYEES);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return parsed.filter(e => {
            const email = (e.email || '').toLowerCase();
            return email !== 'sushovan.das@bimworkspace.com' && email !== 'aditi@bimworkspace.com';
          });
        }
      }
    } catch {}
    return [];
  });

  const [allWorkLogs, setAllWorkLogs] = useState<DailyWorkLog[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.WORK_LOGS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch {}
    return [];
  });

  const [resourceAllocations, setResourceAllocations] = useState<ResourceAllocationItem[]>(() => {
    try {
      const saved = localStorage.getItem('bim_resource_allocations_v2');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch {}
    return [];
  });

  const [generatedReports, setGeneratedReports] = useState<
    GeneratedStakeholderReport[]
  >(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.REPORTS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
      return [];
    } catch {
      return [];
    }
  });

  // Authentication and Onboarding state - Synchronized with Centralized AuthContext
  const auth = useOptionalAuth();

  const [localUser, setLocalUser] = useState<AuthUser | null>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.CURRENT_USER);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.email) return parsed;
      }
      return null;
    } catch {
      return null;
    }
  });

  const currentUser = auth ? auth.user : localUser;

  const setCurrentUser: React.Dispatch<React.SetStateAction<AuthUser | null>> = (
    userOrUpdater
  ) => {
    if (auth) {
      const nextUser =
        typeof userOrUpdater === 'function'
          ? (userOrUpdater as (prev: AuthUser | null) => AuthUser | null)(auth.user)
          : userOrUpdater;

      if (nextUser) {
        auth.updateCurrentUser(nextUser);
      } else {
        auth.logout();
      }
    } else {
      setLocalUser(userOrUpdater);
    }
  };

  const [onboardingRequests, setOnboardingRequests] = useState<OnboardingRequest[]>([]);

  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.AUDIT_LOGS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
      return DEFAULT_AUDIT_LOGS;
    } catch {
      return DEFAULT_AUDIT_LOGS;
    }
  });

  const [selectedProjectId, setSelectedProjectId] = useState<string>('all');
  const [currentTab, setCurrentTab] = useState<ViewTab>('dashboard');
  const [dateFilter, setDateFilter] = useState<string>('all');
  const [globalSearchQuery, setGlobalSearchQuery] = useState<string>('');
  
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.THEME) as ThemeMode | null;
      if (saved === 'light' || saved === 'dark') return saved;
      return 'dark'; // Default dark mode
    } catch {
      return 'dark';
    }
  });

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  // Theme synchronization effect
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.THEME, theme);
      if (theme === 'dark') {
        document.documentElement.classList.add('dark');
        document.documentElement.classList.remove('light');
      } else {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
      }
    } catch (e) {
      console.error('Error saving theme', e);
    }
  }, [theme]);

  // Persistence effects
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(projects));
  }, [projects]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.EMPLOYEES, JSON.stringify(employees));
  }, [employees]);

  // Role-scoped workLogs view:
  // - Super Admins and Directors have global access to all organizational daily logs
  // - Other authenticated members access their own daily logs
  const workLogs = useMemo<DailyWorkLog[]>(() => {
    if (!currentUser) return [];
    if (isUserSuperAdmin(currentUser)) {
      return allWorkLogs;
    }
    return allWorkLogs.filter((l) => isRecordOwnedByMember(l, currentUser, employees));
  }, [allWorkLogs, currentUser, employees]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.WORK_LOGS, JSON.stringify(allWorkLogs));
  }, [allWorkLogs]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.REPORTS, JSON.stringify(generatedReports));
  }, [generatedReports]);

  useEffect(() => {
    if (currentUser) {
      localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(currentUser));
    } else {
      localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
    }
  }, [currentUser]);

  // Synchronize Firestore access_requests collection into onboardingRequests in real-time
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const formatFirestoreTimestamp = (val: any): string => {
      if (!val) return '';
      if (typeof val === 'string') return val;
      if (typeof val?.toDate === 'function') {
        try {
          return val.toDate().toISOString();
        } catch {
          return '';
        }
      }
      if (typeof val?.seconds === 'number') {
        return new Date(val.seconds * 1000).toISOString();
      }
      if (val instanceof Date) {
        return val.toISOString();
      }
      return String(val);
    };

    const mapDocToRequest = (d: any): OnboardingRequest | null => {
      const data = typeof d.data === 'function' ? d.data() : d;
      if (!data) return null;
      const cleanEmail = String(data.email || data.userEmail || data.memberEmail || '').trim().toLowerCase();
      if (!cleanEmail) return null;

      const isSuper = isSuperAdminEmail(cleanEmail);
      const rawStatus = String(data.status || 'pending').trim().toLowerCase();
      const mappedStatus: UserApprovalStatus = isSuper
        ? 'APPROVED'
        : rawStatus === 'approved' || rawStatus === 'active'
        ? 'APPROVED'
        : rawStatus === 'rejected' || rawStatus === 'declined'
        ? 'REJECTED'
        : 'Pending';

      const fullName = String(data.fullName || data.name || cleanEmail.split('@')[0]).trim();
      const discipline = String(data.discipline || data.primaryDiscipline || data.organization || 'BIM - ACS');
      const reasonForAccess = String(
        data.reasonForAccess || data.accessReason || 'Sign-in Access Request for ProductionPulse BPMS'
      );
      const createdAt =
        formatFirestoreTimestamp(data.createdAt) ||
        formatFirestoreTimestamp(data.requestedAt) ||
        formatFirestoreTimestamp(data.timestamp) ||
        new Date().toISOString();
      const updatedAt =
        formatFirestoreTimestamp(data.updatedAt) ||
        formatFirestoreTimestamp(data.reviewedAt) ||
        createdAt;

      const normalizedRole: UserRole = normalizeUserRole(
        data.assignedRole || data.role || data.appRole || data.requestedRole,
        isSuper
      );
      const calculatedAccessLevel: AccessLevel =
        (data.assignedAccessLevel as AccessLevel) || mapAppRoleToAccessLevel(normalizedRole);

      return {
        id: d.id,
        googleId: data.uid || d.id,
        email: cleanEmail,
        name: fullName,
        fullName: fullName,
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(fullName)}`,
        role: data.role || mapAppRoleToDisplayRole(normalizedRole),
        requestedRole: data.requestedRole || data.role || mapAppRoleToDisplayRole(normalizedRole),
        assignedRole: normalizedRole,
        assignedAccessLevel: calculatedAccessLevel,
        primaryDiscipline: discipline,
        discipline: discipline,
        organization: data.organization || discipline,
        reasonForAccess: reasonForAccess,
        accessReason: reasonForAccess,
        createdAt: createdAt,
        requestedAt: createdAt,
        requestTimestamp: createdAt,
        timestamp: updatedAt,
        status: mappedStatus,
        reviewedBy: data.reviewedBy,
        reviewedAt: formatFirestoreTimestamp(data.reviewedAt) || undefined,
        notes: data.notes || 'Sign-in access request awaiting Super Admin review in Admin Nexus.',
      };
    };

    const deduplicateAndSortRequests = (rawList: OnboardingRequest[]): OnboardingRequest[] => {
      const byEmail = new Map<string, OnboardingRequest>();
      // Sort by newest timestamp first so latest submission or admin review for an email wins
      const sorted = [...rawList].sort((a, b) => {
        const tA = new Date(a.timestamp || a.createdAt || 0).getTime() || 0;
        const tB = new Date(b.timestamp || b.createdAt || 0).getTime() || 0;
        if (tB !== tA) return tB - tA;
        const rank = (s?: string) => {
          const u = (s || '').toUpperCase();
          if (u === 'PENDING') return 3;
          if (u === 'APPROVED' || u === 'ACTIVE') return 2;
          return 1;
        };
        return rank(b.status) - rank(a.status);
      });

      for (const req of sorted) {
        const key = (req.email || '').trim().toLowerCase();
        if (!key) continue;
        if (!byEmail.has(key)) {
          byEmail.set(key, req);
        }
      }

      return Array.from(byEmail.values()).sort((a, b) => {
        const tA = new Date(a.createdAt || a.timestamp || 0).getTime() || 0;
        const tB = new Date(b.createdAt || b.timestamp || 0).getTime() || 0;
        return tB - tA;
      });
    };

    try {
      const colRef = collection(db, 'access_requests');

      // Helper to synchronize approved access requests into active employees list
      const syncApprovedToEmployees = (reqList: OnboardingRequest[]) => {
        const approvedFromFirestore = reqList.filter(
          (r) => (r.status || '').toUpperCase() === 'APPROVED' || (r.status || '').toLowerCase() === 'approved'
        );
        if (approvedFromFirestore.length > 0) {
          setEmployees((currentEmployees) => {
            let changed = false;
            const updated = [...currentEmployees];
            approvedFromFirestore.forEach((req) => {
              const email = (req.email || '').toLowerCase().trim();
              if (!email) return;
              const idx = updated.findIndex((e) => (e.email || '').toLowerCase().trim() === email);
              const name = (req.fullName || req.name || email.split('@')[0]).trim();
              const disc = ((req.discipline || req.primaryDiscipline || 'BIM - ACS') as Discipline);
              const role =
                req.role && req.role !== 'Editor' && req.role !== 'editor'
                  ? req.role
                  : mapAppRoleToDisplayRole((req.assignedRole as UserRole) || 'EDITOR');

              if (idx === -1) {
                changed = true;
                updated.push({
                  id: `emp-${req.id || Date.now()}`,
                  name,
                  email: req.email,
                  role,
                  primaryDiscipline: disc,
                  discipline: disc,
                  avatar: req.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name)}`,
                  weeklyCapacityHours: 40,
                  experienceYears: 4,
                  status: 'Active',
                  activeProjectIds: [projects[0]?.id || 'proj-1'],
                  skills: [disc, 'Revit 2026', 'Navisworks Manage', 'BIM Coordination'],
                  phone: '+1 (555) 019-2834',
                });
              } else {
                if (req.assignedRole && updated[idx].role !== role) {
                  changed = true;
                  updated[idx] = {
                    ...updated[idx],
                    role,
                  };
                }
              }
            });
            return changed ? updated : currentEmployees;
          });
        }
      };

      // Real-time onSnapshot listener (delivers initial snapshot + live changes without redundant getDocs)
      unsubscribe = onSnapshot(
        colRef,
        (snapshot) => {
          const rawList = snapshot.docs.map(mapDocToRequest).filter(Boolean) as OnboardingRequest[];
          const list = deduplicateAndSortRequests(rawList);
          setOnboardingRequests(list);
          syncApprovedToEmployees(list);
        },
        (err) => {
          console.warn('Firestore access_requests listener notice:', err);
        }
      );
    } catch (e) {
      console.warn('Firestore onSnapshot listener error:', e);
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // Synchronize Firestore projects collection into state in real-time via onSnapshot
  const hasSeededProjectsRef = React.useRef(false);
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const colRef = collection(db, 'projects');
      unsubscribe = onSnapshot(
        colRef,
        (snapshot) => {
          const firestoreDocsMap = new Map<string, Partial<BimProject> & { _createdAtMs?: number }>();
          snapshot.docs.forEach((docSnap) => {
            const data = docSnap.data();
            const resolvedName = data.name || data.projectName;
            const resolvedEstHours =
              data.totalEstimatedHours !== undefined
                ? Number(data.totalEstimatedHours)
                : data.estimatedHours !== undefined
                ? Number(data.estimatedHours)
                : undefined;
            const resolvedLoggedHours =
              data.totalCompletedHours !== undefined
                ? Number(data.totalCompletedHours)
                : data.totalHoursLogged !== undefined
                ? Number(data.totalHoursLogged)
                : undefined;
            const resolvedPlannedDate = data.plannedDeliveryDate || data.targetCompletionDate;
            let createdAtMs = 0;
            if (data.createdAt) {
              if (typeof data.createdAt?.toMillis === 'function') {
                createdAtMs = data.createdAt.toMillis();
              } else if (typeof data.createdAt?.seconds === 'number') {
                createdAtMs = data.createdAt.seconds * 1000;
              } else {
                const parsed = new Date(data.createdAt).getTime();
                if (!Number.isNaN(parsed)) createdAtMs = parsed;
              }
            }

            firestoreDocsMap.set(docSnap.id, {
              id: docSnap.id,
              _createdAtMs: createdAtMs,
              ...(data.code !== undefined ? { code: data.code } : {}),
              ...(resolvedName !== undefined ? { name: resolvedName } : {}),
              ...(data.clientName !== undefined ? { clientName: data.clientName } : {}),
              ...(data.buildingType !== undefined ? { buildingType: data.buildingType } : {}),
              ...(data.location !== undefined ? { location: data.location } : {}),
              ...(data.grossFloorAreaSqm !== undefined ? { grossFloorAreaSqm: Number(data.grossFloorAreaSqm) } : {}),
              ...(data.startDate !== undefined ? { startDate: data.startDate } : {}),
              ...(resolvedPlannedDate !== undefined
                ? {
                    targetCompletionDate: data.targetCompletionDate || resolvedPlannedDate,
                    plannedDeliveryDate: resolvedPlannedDate,
                  }
                : {}),
              ...(data.actualDeliveredDate !== undefined ? { actualDeliveredDate: data.actualDeliveredDate } : {}),
              ...(data.status !== undefined ? { status: data.status } : {}),
              ...(resolvedEstHours !== undefined ? { totalEstimatedHours: resolvedEstHours } : {}),
              ...(resolvedLoggedHours !== undefined ? { totalCompletedHours: resolvedLoggedHours } : {}),
              ...(data.manualHoursOverride !== undefined ? { manualHoursOverride: Number(data.manualHoursOverride) } : {}),
              ...(data.manualHoursBaseLogged !== undefined ? { manualHoursBaseLogged: Number(data.manualHoursBaseLogged) } : {}),
              ...(data.currentLOD !== undefined ? { currentLOD: data.currentLOD } : {}),
              ...(data.targetLOD !== undefined ? { targetLOD: data.targetLOD } : {}),
              ...(data.budgetAmount !== undefined ? { budgetAmount: Number(data.budgetAmount) } : {}),
              ...(data.disciplines !== undefined ? { disciplines: data.disciplines } : {}),
              ...(data.milestones !== undefined ? { milestones: data.milestones } : {}),
              ...(data.tasks !== undefined ? { tasks: data.tasks } : {}),
              ...(data.clashes !== undefined ? { clashes: data.clashes } : {}),
              ...(data.assignedEmployeeIds !== undefined ? { assignedEmployeeIds: data.assignedEmployeeIds } : {}),
              ...(data.description !== undefined ? { description: data.description } : {}),
            });
          });

          setProjects((prev) => {
            // Seed initial portfolio projects to Firestore once if not yet present in Firestore
            if (!hasSeededProjectsRef.current && !snapshot.metadata.fromCache) {
              hasSeededProjectsRef.current = true;
              prev.forEach((p) => {
                if (!firestoreDocsMap.has(p.id)) {
                  const sanitized = JSON.parse(JSON.stringify(p));
                  setDoc(
                    doc(db, 'projects', p.id),
                    {
                      ...sanitized,
                      projectName: p.name,
                      status: p.status || 'WIP',
                      estimatedHours: Number(p.totalEstimatedHours) || 0,
                      totalHoursLogged: Number(p.totalCompletedHours) || 0,
                      plannedDeliveryDate: p.plannedDeliveryDate || p.targetCompletionDate || '2026-11-30',
                      createdAt: serverTimestamp(),
                    },
                    { merge: true }
                  ).catch(() => {});
                }
              });
            }

            if (firestoreDocsMap.size === 0) {
              return prev;
            }

            const existingIds = new Set(prev.map((p) => p.id));
            const merged = prev.map((p) => {
              const remote = firestoreDocsMap.get(p.id);
              if (!remote) return p;
              const { _createdAtMs, ...cleanRemote } = remote;
              return { ...p, ...cleanRemote };
            });

            const newRemoteEntries: Array<{ proj: BimProject; createdAtMs: number }> = [];
            firestoreDocsMap.forEach((remote, id) => {
              if (!existingIds.has(id) && remote.name) {
                const defaultCode =
                  remote.code ||
                  `BIM-${remote.name
                    .replace(/[^a-zA-Z0-9]/g, '')
                    .slice(0, 4)
                    .toUpperCase() || 'PRJ'}`;
                newRemoteEntries.push({
                  createdAtMs: remote._createdAtMs || 0,
                  proj: {
                    id,
                    code: defaultCode,
                    name: remote.name,
                    clientName: remote.clientName || 'Enterprise Client',
                    buildingType: remote.buildingType || 'Commercial',
                    location: remote.location || 'Global',
                    grossFloorAreaSqm: remote.grossFloorAreaSqm || 1000,
                    startDate: remote.startDate || toLocalIsoDate(new Date()),
                    targetCompletionDate: remote.targetCompletionDate || remote.plannedDeliveryDate || '2026-11-30',
                    plannedDeliveryDate: remote.plannedDeliveryDate || remote.targetCompletionDate || '2026-11-30',
                    actualDeliveredDate: remote.actualDeliveredDate,
                    status: remote.status || 'WIP',
                    totalEstimatedHours: Number(remote.totalEstimatedHours) || 0,
                    totalCompletedHours: Number(remote.totalCompletedHours) || 0,
                    manualHoursOverride: remote.manualHoursOverride,
                    manualHoursBaseLogged: remote.manualHoursBaseLogged,
                    currentLOD: remote.currentLOD || 'LOD 300',
                    targetLOD: remote.targetLOD || 'LOD 350',
                    budgetAmount: Number(remote.budgetAmount) || 0,
                    disciplines:
                      Array.isArray(remote.disciplines) && remote.disciplines.length > 0
                        ? remote.disciplines
                        : ['BIM - ACS'],
                    milestones: Array.isArray(remote.milestones) ? remote.milestones : [],
                    tasks: Array.isArray(remote.tasks) ? remote.tasks : [],
                    clashes: Array.isArray(remote.clashes) ? remote.clashes : [],
                    assignedEmployeeIds: Array.isArray(remote.assignedEmployeeIds)
                      ? remote.assignedEmployeeIds
                      : [],
                    description: remote.description || '',
                  },
                });
              }
            });

            // Sort newest first so newly created projects appear at the top
            newRemoteEntries.sort((a, b) => b.createdAtMs - a.createdAtMs);
            return [...newRemoteEntries.map((e) => e.proj), ...merged];
          });
        },
        (err) => {
          console.warn('Firestore projects listener notice:', err);
        }
      );
    } catch (e) {
      console.warn('Firestore projects setup error:', e);
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // Synchronize Firestore work_logs collection into state in real-time via onSnapshot()
  // - Super Admins & Directors view all organizational daily logs in real time
  // - Standard engineers view their own logs (enforced via role-scoped workLogs memo & DailyHourTracker)
  // - Project hour totals (Total Logged Hours & Remaining Hours) recalculate automatically on every snapshot
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    try {
      const colRef = collection(db, 'work_logs');
      unsubscribe = onSnapshot(
        colRef,
        (snapshot) => {
          const list: DailyWorkLog[] = snapshot.docs.map((docSnap) => {
            const data = docSnap.data();
            const normalizedEmail = (data.memberEmail || data.userEmail || '').trim().toLowerCase();
            return {
              id: docSnap.id,
              employeeId: data.employeeId || data.userId || '',
              employeeName: data.employeeName || 'BIM Modeler',
              projectId: data.projectId || '',
              projectName: data.projectName || 'BIM Project',
              date: data.date || new Date().toISOString().slice(0, 10),
              hoursLogged: Number(data.hoursLogged !== undefined ? data.hoursLogged : data.hours) || 0,
              discipline: (data.discipline as Discipline) || 'BIM - ACS',
              activityType: (data.activityType as ActivityType) || '3D Detailed Modeling',
              taskName: data.taskName || 'BIM Modeling Task',
              lodStage: (data.lodStage as LODLevel) || 'LOD 350',
              notes: data.notes || '',
              billable: data.billable !== undefined ? Boolean(data.billable) : true,
              timestamp: data.timestamp || new Date().toISOString(),
              memberEmail: normalizedEmail,
              userEmail: normalizedEmail,
              userId: data.userId || data.employeeId || '',
            };
          });

          // Sort newest first by log date, then submission timestamp
          list.sort((a, b) => {
            const dateDiff = new Date(b.date).getTime() - new Date(a.date).getTime();
            if (dateDiff !== 0) return dateDiff;
            return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
          });

          setAllWorkLogs(list);

          // Ensure any engineer who submitted work logs is represented in employees state
          if (list.length > 0) {
            setEmployees((currentEmployees) => {
              let changed = false;
              const updated = [...currentEmployees];

              list.forEach((log) => {
                const emailKey = (log.memberEmail || log.userEmail || '').trim().toLowerCase();
                const nameKey = (log.employeeName || '').trim().toLowerCase();
                const rawId = (log.employeeId || log.userId || '').trim();
                const strippedId = rawId.replace(/^emp-/, '');

                if (!emailKey && !nameKey && !rawId) return;
                if (emailKey === 'sushovan.das@bimworkspace.com' || emailKey === 'aditi@bimworkspace.com') return;

                const exists = updated.some((e) => {
                  const eEmail = (e.email || '').trim().toLowerCase();
                  const eName = (e.name || '').trim().toLowerCase();
                  const eIdStripped = (e.id || '').replace(/^emp-/, '');
                  return (
                    (rawId && (e.id === rawId || eIdStripped === strippedId)) ||
                    (emailKey && eEmail === emailKey) ||
                    (nameKey && eName === nameKey)
                  );
                });

                if (!exists && (nameKey || emailKey)) {
                  changed = true;
                  const empId = rawId.startsWith('emp-')
                    ? rawId
                    : rawId
                    ? `emp-${rawId}`
                    : emailKey
                    ? `emp-${generateRequestDocId(emailKey)}`
                    : `emp-${Date.now()}`;
                  const displayName = log.employeeName || (emailKey ? emailKey.split('@')[0] : 'BIM Engineer');
                  const disc = (log.discipline as Discipline) || 'BIM - ACS';

                  updated.push({
                    id: empId,
                    name: displayName,
                    email: emailKey,
                    role: 'BIM Modeler' as any,
                    primaryDiscipline: disc,
                    discipline: disc,
                    avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(displayName)}`,
                    weeklyCapacityHours: 40,
                    experienceYears: 3,
                    status: 'Active',
                    activeProjectIds: log.projectId ? [log.projectId] : [],
                    skills: [disc],
                    phone: '',
                  });
                }
              });

              return changed ? updated : currentEmployees;
            });
          }
        },
        (err) => {
          console.warn('Firestore work_logs real-time listener notice:', err);
        }
      );
    } catch (e) {
      console.warn('Firestore work_logs setup error:', e);
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [
    currentUser?.email,
    currentUser?.id,
    currentUser?.role,
    currentUser?.securityRole,
    currentUser?.appRole,
    currentUser?.accessLevel,
  ]);

  // Synchronize Firestore project_assignments collection into resourceAllocations in real-time
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const handleLocalAllocUpdate = (e: any) => {
      if (e?.detail && Array.isArray(e.detail)) {
        setResourceAllocations(e.detail);
      }
    };
    window.addEventListener('bim_resource_allocations_updated', handleLocalAllocUpdate);

    try {
      const colRef = collection(db, 'project_assignments');
      unsubscribe = onSnapshot(
        colRef,
        (snapshot) => {
          const remoteAllocations: ResourceAllocationItem[] = snapshot.docs.map((docSnap) => {
            const data = docSnap.data();
            return {
              id: docSnap.id,
              projectId: data.projectId || '',
              projectName: data.projectName || 'Unassigned Project',
              employeeId: data.employeeId || '',
              employeeName: data.employeeName || '',
              employeeRole: data.employeeRole || 'Editor',
              memberEmail: data.memberEmail || '',
              discipline: data.discipline || 'BIM - ACS',
              lod: data.lod || 'LOD 350',
              projectPhase: data.projectPhase || 'Design Development',
              taskType: data.taskType || '3D Modeling',
              targetElementOrZone: data.targetElementOrZone || 'MOD-AR-LVL01-ZONE-A',
              assignedHours: Number(data.assignedHours) || 0,
              viewFrequency: data.viewFrequency || 'Weekly',
              startDate: data.startDate || toLocalIsoDate(new Date()),
              dueDate: data.dueDate || toLocalIsoDate(new Date()),
              priority: data.priority || 'High',
              status: data.status || 'Allocated',
              notes: data.notes || '',
            };
          });

          setResourceAllocations(remoteAllocations);
          try {
            localStorage.setItem('bim_resource_allocations_v2', JSON.stringify(remoteAllocations));
          } catch {}
        },
        (err) => {
          console.warn('Firestore project_assignments context listener notice:', err);
        }
      );
    } catch (e) {
      console.warn('Firestore project_assignments context setup error:', e);
    }

    return () => {
      window.removeEventListener('bim_resource_allocations_updated', handleLocalAllocUpdate);
      if (unsubscribe) unsubscribe();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.AUDIT_LOGS, JSON.stringify(auditLogs));
  }, [auditLogs]);

  // Auth & Onboarding Actions (Phase 1 Google OAuth & RBAC)
  const signInWithGoogle = (profile: {
    googleId?: string;
    email: string;
    name?: string;
    picture?: string;
    organization?: string;
    discipline?: string;
    accessReason?: string;
  }): { status: UserApprovalStatus; user: AuthUser } => {
    const trimmedEmail = profile.email.trim().toLowerCase();
    const isSuperAdminUser =
      trimmedEmail === SUPER_ADMIN_EMAIL.toLowerCase() ||
      profile.name?.toLowerCase().includes('sushoovan das');

    // 1. Super Admin Bypass: immediate APPROVED + SUPER_ADMIN
    if (isSuperAdminUser) {
      const superAdminUser: AuthUser = {
        id: 'usr_super_admin_sushoovan',
        googleId: profile.googleId || 'google_super_admin_sushoovan',
        email: SUPER_ADMIN_EMAIL,
        name: SUPER_ADMIN_NAME,
        role: 'Super Administrator & Lead Architect',
        appRole: 'SUPER_ADMIN',
        status: 'APPROVED',
        isAdmin: true,
        accessLevel: 'Super Admin',
        organization: 'BPMS Core Systems & Architecture',
        accessReason: 'Executive Super Administrator with master editing and governance access',
        requestTimestamp: '2026-08-23 09:00 AM',
        avatar: profile.picture || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=250',
      };
      setCurrentUser(superAdminUser);
      return { status: 'APPROVED', user: superAdminUser };
    }

    // 2. Check existing onboarding requests first so pending/rejected requests are respected
    const existingReq = onboardingRequests.find(
      (r) => r.email.toLowerCase() === trimmedEmail
    );

    if (existingReq) {
      const resolvedRole: UserRole =
        existingReq.assignedRole ||
        normalizeUserRole(existingReq.role || existingReq.requestedRole);
      const isApprovedReq =
        (existingReq.status || '').toUpperCase() === 'APPROVED' ||
        (existingReq.status || '').toUpperCase() === 'ACTIVE';

      const authUser: AuthUser = {
        id: existingReq.id,
        googleId: profile.googleId || existingReq.googleId,
        email: existingReq.email,
        name: profile.name || existingReq.name,
        role: mapAppRoleToDisplayRole(resolvedRole),
        appRole: resolvedRole,
        status: isApprovedReq ? 'APPROVED' : existingReq.status,
        isAdmin: resolvedRole === 'SUPER_ADMIN' || resolvedRole === 'DIRECTOR' || resolvedRole === 'PROJECT_MANAGER',
        accessLevel: existingReq.assignedAccessLevel || mapAppRoleToAccessLevel(resolvedRole),
        avatar: profile.picture || existingReq.avatar,
        organization: existingReq.organization || profile.organization || 'ProductionPulse Partner Network',
        accessReason: existingReq.accessReason || profile.accessReason || existingReq.notes,
        requestTimestamp: existingReq.requestTimestamp,
      };

      // Only add to active employees roster if the request is actually APPROVED
      if (isApprovedReq) {
        const existingEmp = employees.find(
          (e) => e.email.toLowerCase() === trimmedEmail
        );
        if (!existingEmp) {
          const newEmp: Employee = {
            id: `emp-${Date.now()}`,
            name: authUser.name,
            email: trimmedEmail,
            role: authUser.role || 'Editor',
            avatar: authUser.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(authUser.name)}`,
            primaryDiscipline: (profile.discipline as Discipline) || (existingReq.primaryDiscipline as Discipline) || 'BIM - ACS',
            discipline: (profile.discipline as Discipline) || (existingReq.primaryDiscipline as Discipline) || 'BIM - ACS',
            weeklyCapacityHours: 40,
            status: 'Active',
            activeProjectIds: [projects[0]?.id || 'proj-1'],
            skills: ['Revit 2026', 'Navisworks Manage', 'BIM 360'],
          };
          setEmployees((prev) => [...prev, newEmp]);
        }
      }

      setCurrentUser(authUser);
      return { status: authUser.status, user: authUser };
    }

    // 3. Check if user was already approved in employees roster
    const matchedEmployee = employees.find(
      (e) => e.email.toLowerCase() === trimmedEmail && e.status !== 'Suspended'
    );

    if (matchedEmployee) {
      const resolvedAppRole: UserRole = normalizeUserRole(matchedEmployee.role);
      const resolvedAccessLevel = mapAppRoleToAccessLevel(resolvedAppRole);
      const resolvedDisplayRole = mapAppRoleToDisplayRole(resolvedAppRole);

      const activeUser: AuthUser = {
        id: matchedEmployee.id,
        googleId: profile.googleId,
        email: matchedEmployee.email,
        name: matchedEmployee.name,
        role: resolvedDisplayRole,
        appRole: resolvedAppRole,
        status: 'APPROVED',
        isAdmin: resolvedAppRole === 'SUPER_ADMIN' || resolvedAppRole === 'DIRECTOR' || resolvedAppRole === 'PROJECT_MANAGER',
        accessLevel: resolvedAccessLevel,
        avatar: profile.picture || matchedEmployee.avatar,
        organization: profile.organization || 'BPMS Production Team',
        requestTimestamp: '2026-08-23 09:00 AM',
      };
      setCurrentUser(activeUser);
      return { status: 'APPROVED', user: activeUser };
    }

    // 4. New Google User -> default to PENDING hold state and add to Admin Nexus Queue
    const timestamp = new Date().toLocaleString([], {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    const formattedName =
      profile.name?.trim() ||
      trimmedEmail
        .split('@')[0]
        .split(/[._-]/)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ');

    const isoTimestamp = new Date().toISOString();
    const requestId = generateRequestDocId(trimmedEmail);
    const newRequest: OnboardingRequest = {
      id: requestId,
      googleId: profile.googleId || requestId,
      email: trimmedEmail,
      name: formattedName,
      fullName: formattedName,
      avatar: profile.picture || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(formattedName)}`,
      role: 'Editor',
      requestedRole: 'Editor',
      assignedRole: 'EDITOR',
      assignedAccessLevel: 'Editor',
      primaryDiscipline: (profile.discipline as Discipline) || 'BIM - ACS',
      discipline: (profile.discipline as Discipline) || 'BIM - ACS',
      createdAt: isoTimestamp,
      requestedAt: isoTimestamp,
      requestTimestamp: timestamp,
      timestamp: isoTimestamp,
      status: 'Pending',
      organization: profile.organization || 'Google Workspace Authenticated Partner',
      reasonForAccess: profile.accessReason || 'BIM Model Review, coordination, and production tracking access.',
      accessReason: profile.accessReason || 'BIM Model Review, coordination, and production tracking access.',
      notes: 'Authenticated via Google OAuth (Gmail). Awaiting Super Admin review in Nexus Admin Panel.',
    };

    setOnboardingRequests((prev) => [newRequest, ...prev.filter((r) => r.email.toLowerCase() !== trimmedEmail)]);

    // Save to Firestore access_requests collection
    try {
      const reqDoc = doc(db, 'access_requests', newRequest.id);
      setDoc(
        reqDoc,
        {
          id: newRequest.id,
          uid: profile.googleId || newRequest.id,
          name: formattedName,
          fullName: formattedName,
          email: trimmedEmail,
          role: 'Editor',
          assignedRole: 'EDITOR',
          requestedRole: 'Editor',
          discipline: (profile.discipline as Discipline) || 'BIM - ACS',
          primaryDiscipline: (profile.discipline as Discipline) || 'BIM - ACS',
          organization: profile.organization || 'Google Workspace Partner',
          reasonForAccess: profile.accessReason || 'BIM Model review & coordination',
          accessReason: profile.accessReason || 'BIM Model review & coordination',
          status: 'Pending',
          createdAt: isoTimestamp,
          requestedAt: isoTimestamp,
          timestamp: isoTimestamp,
          requestTimestamp: timestamp,
        },
        { merge: true }
      ).catch((err) => {
        console.warn('Firestore setDoc error in signInWithGoogle:', err);
      });
    } catch (err) {
      console.warn('Firestore error in signInWithGoogle:', err);
    }

    // Immediately record to Admin Audit Trail
    const newAudit: AdminAuditLog = {
      id: `audit-${Date.now()}`,
      action: 'joined',
      targetUserEmail: trimmedEmail,
      targetUserName: formattedName,
      performedBy: 'Google Workspace SSO (Gmail)',
      timestamp,
      details: `New external user authenticated via Google SSO: ${trimmedEmail} (${formattedName}). Org: ${profile.organization || 'Google Workspace'}. Registered in Admin Nexus awaiting Super Admin review and access level assignment.`,
    };
    setAuditLogs((prev) => [newAudit, ...prev]);

    const newPendingUser: AuthUser = {
      id: newRequest.id,
      googleId: profile.googleId,
      email: newRequest.email,
      name: newRequest.name,
      avatar: newRequest.avatar,
      role: newRequest.requestedRole,
      appRole: 'VIEWER',
      status: 'PENDING',
      isAdmin: false,
      accessLevel: 'Viewer',
      organization: newRequest.organization,
      accessReason: newRequest.accessReason,
      requestTimestamp: timestamp,
    };

    setCurrentUser(newPendingUser);
    return { status: 'PENDING', user: newPendingUser };
  };

  const signInWithEmail = (
    email: string,
    name?: string
  ): { status: UserApprovalStatus; user: AuthUser } => {
    return signInWithGoogle({
      email,
      name,
    });
  };

  const requestAccess = (params: {
    name: string;
    email: string;
    requestedRole: string;
    primaryDiscipline: Discipline;
    organization?: string;
    accessReason?: string;
  }): { status: UserApprovalStatus; user: AuthUser } => {
    return signInWithGoogle({
      email: params.email,
      name: params.name,
      organization: params.organization,
      discipline: params.primaryDiscipline,
      accessReason: params.accessReason,
    });
  };

  const updateAccessRequestReason = (
    requestId: string,
    accessReason: string,
    organization?: string
  ) => {
    setOnboardingRequests((prev) =>
      prev.map((r) =>
        r.id === requestId || (currentUser && r.email.toLowerCase() === currentUser.email.toLowerCase())
          ? {
              ...r,
              accessReason,
              ...(organization ? { organization } : {}),
            }
          : r
      )
    );

    if (currentUser) {
      setCurrentUser({
        ...currentUser,
        accessReason,
        ...(organization ? { organization } : {}),
      });
    }
  };

  const checkUserStatus = () => {
    if (!currentUser) return;

    if (
      isSuperAdminEmail(currentUser.email) ||
      currentUser.name.toLowerCase().includes('sushoovan das')
    ) {
      setCurrentUser((prev) =>
        prev
          ? {
              ...prev,
              status: 'APPROVED',
              appRole: 'SUPER_ADMIN',
              isAdmin: true,
              accessLevel: 'Super Admin',
            }
          : null
      );
      return;
    }

    // Check onboarding requests
    const matchingReq = onboardingRequests.find(
      (r) => r.email.toLowerCase() === currentUser.email.toLowerCase()
    );
    if (matchingReq) {
      setCurrentUser((prev) =>
        prev
          ? {
              ...prev,
              status: matchingReq.status,
              role: matchingReq.requestedRole,
              appRole: (matchingReq.assignedRole as UserRole) || prev.appRole,
              accessLevel: matchingReq.assignedAccessLevel || prev.accessLevel,
              organization: matchingReq.organization || prev.organization,
              accessReason: matchingReq.accessReason || prev.accessReason,
            }
          : null
      );
    }
  };

  /**
   * Register direct access request submitted from landing page contact/submission form.
   * Ensures instant sync across state, localStorage, audit logs, and Firestore.
   */
  const registerAccessRequest = async (params: {
    name: string;
    email: string;
    fullName?: string;
    discipline?: string;
    reasonForAccess?: string;
    uid?: string;
    organization?: string;
    accessReason?: string;
    existingDbRecord?: DatabaseRoleResult;
    skipFirestoreWrite?: boolean;
  }): Promise<OnboardingRequest> => {
    const trimmedEmail = params.email.trim().toLowerCase();
    const formattedName = (params.fullName || params.name || '').trim() || trimmedEmail.split('@')[0];
    const requestId = params.uid || generateRequestDocId(trimmedEmail);
    const timestamp = new Date().toLocaleString([], {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    const isoTimestamp = new Date().toISOString();
    const discipline = params.discipline || params.organization || 'BIM - ACS';
    const reasonForAccess = params.reasonForAccess || params.accessReason || 'Sign-in Access Request for ProductionPulse BPMS';

    // Check if an access request already exists in memory or Firestore database
    const existingReq = onboardingRequests.find(
      (r) => (r.email || '').toLowerCase().trim() === trimmedEmail || r.id === requestId
    );
    const dbRecord = params.existingDbRecord || (await fetchUserRoleFromDatabase(trimmedEmail, requestId));
    const isExistingUser = Boolean(existingReq || (dbRecord && dbRecord.source !== 'default'));

    const preservedAppRole: UserRole =
      existingReq?.assignedRole ||
      (dbRecord && dbRecord.source !== 'default' ? dbRecord.role : 'EDITOR');

    const preservedStatus: UserApprovalStatus =
      existingReq?.status ||
      (dbRecord && dbRecord.source !== 'default' ? dbRecord.status : 'Pending');

    const preservedAccessLevel: AccessLevel =
      existingReq?.assignedAccessLevel ||
      (dbRecord && dbRecord.source !== 'default' ? dbRecord.accessLevel : mapAppRoleToAccessLevel(preservedAppRole));

    const preservedDisplayRole: string =
      existingReq?.role ||
      (dbRecord && dbRecord.source !== 'default' ? dbRecord.displayRole : mapAppRoleToDisplayRole(preservedAppRole));

    const effectiveDocId = existingReq?.id || requestId;

    const newRequest: OnboardingRequest = {
      id: effectiveDocId,
      googleId: existingReq?.googleId || effectiveDocId,
      email: trimmedEmail,
      name: formattedName,
      fullName: formattedName,
      avatar: existingReq?.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(formattedName)}`,
      role: preservedDisplayRole,
      requestedRole: existingReq?.requestedRole || 'Editor',
      assignedRole: preservedAppRole,
      assignedAccessLevel: preservedAccessLevel,
      primaryDiscipline: existingReq?.primaryDiscipline || discipline,
      discipline: existingReq?.discipline || discipline,
      createdAt: existingReq?.createdAt || isoTimestamp,
      requestedAt: existingReq?.requestedAt || isoTimestamp,
      requestTimestamp: existingReq?.requestTimestamp || timestamp,
      timestamp: existingReq?.timestamp || isoTimestamp,
      status: preservedStatus,
      organization: existingReq?.organization || discipline,
      reasonForAccess: existingReq?.reasonForAccess || reasonForAccess,
      accessReason: existingReq?.accessReason || reasonForAccess,
      notes: existingReq?.notes || 'Sign-in access request awaiting Super Admin review in Admin Nexus.',
      reviewedBy: existingReq?.reviewedBy,
      reviewedAt: existingReq?.reviewedAt,
    };

    // 1. Update in-memory React state while preserving existing assigned roles
    setOnboardingRequests((prev) => [
      newRequest,
      ...prev.filter((r) => (r.email || '').toLowerCase().trim() !== trimmedEmail && r.id !== effectiveDocId),
    ]);

    // 2. Log to Admin Audit Trail if newly registered
    if (!isExistingUser) {
      const newAudit: AdminAuditLog = {
        id: `audit-${Date.now()}`,
        action: 'joined',
        targetUserEmail: trimmedEmail,
        targetUserName: formattedName,
        performedBy: 'Sign-in Access Gateway',
        timestamp,
        details: `New access request submitted from sign-in: ${formattedName} (${trimmedEmail}). Registered in Admin Nexus awaiting Super Admin approval.`,
      };
      setAuditLogs((prev) => [newAudit, ...prev]);
    }

    // 3. Save to central database collection Firestore access_requests unless caller already wrote it
    if (!params.skipFirestoreWrite) {
      if (isExistingUser && preservedStatus === 'APPROVED') {
        const reqDoc = doc(db, 'access_requests', effectiveDocId);
        await setDoc(
          reqDoc,
          {
            id: effectiveDocId,
            uid: effectiveDocId,
            fullName: formattedName,
            name: formattedName,
            email: trimmedEmail,
            lastLoginAt: isoTimestamp,
            lastActive: isoTimestamp,
            updatedAt: isoTimestamp,
          },
          { merge: true }
        );
      } else {
        const docRef = await addDoc(collection(db, 'access_requests'), {
          name: formattedName,
          fullName: formattedName,
          email: trimmedEmail,
          discipline,
          primaryDiscipline: discipline,
          organization: discipline,
          reasonForAccess,
          accessReason: reasonForAccess,
          status: 'pending',
          role: 'Editor',
          assignedRole: 'EDITOR',
          requestedRole: 'Editor',
          createdAt: isoTimestamp,
          requestedAt: isoTimestamp,
          timestamp: isoTimestamp,
          requestTimestamp: timestamp,
          updatedAt: isoTimestamp,
        });
        newRequest.id = docRef.id;
      }
    }

    return newRequest;
  };

  const approveOnboardingRequest = (
    requestId: string,
    assignedRole: UserRole | string = 'EDITOR',
    assignedAccessLevel?: AccessLevel,
    assignedDiscipline?: Discipline | string
  ) => {
    let approvedReq: OnboardingRequest | undefined;

    const actionTimestamp = new Date().toLocaleString([], {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    const validatedRole: UserRole =
      assignedRole === 'SUPER_ADMIN' || assignedRole === 'DIRECTOR' || assignedRole === 'PROJECT_MANAGER' || assignedRole === 'EDITOR' || assignedRole === 'VIEWER'
        ? assignedRole
        : normalizeUserRole(assignedRole);

    const calculatedAccessLevel: AccessLevel =
      assignedAccessLevel || mapAppRoleToAccessLevel(validatedRole);

    const displayRole = mapAppRoleToDisplayRole(validatedRole);

    const reqTarget = onboardingRequests.find((r) => r.id === requestId);
    const targetDiscipline: Discipline =
      (assignedDiscipline as Discipline) ||
      (reqTarget?.discipline as Discipline) ||
      (reqTarget?.primaryDiscipline as Discipline) ||
      'BIM - ACS';

    setOnboardingRequests((prev) =>
      prev.map((r) => {
        if (r.id === requestId || (reqTarget && r.email.toLowerCase() === reqTarget.email.toLowerCase())) {
          approvedReq = {
            ...r,
            status: 'APPROVED',
            reviewedBy: `${SUPER_ADMIN_NAME} (Super Admin)`,
            reviewedAt: actionTimestamp,
            assignedRole: validatedRole,
            assignedAccessLevel: calculatedAccessLevel,
            requestedRole: displayRole,
            role: displayRole,
            discipline: targetDiscipline,
            primaryDiscipline: targetDiscipline,
          };
          return approvedReq;
        }
        return r;
      })
    );

    const effectiveReq = approvedReq || reqTarget;

    if (effectiveReq) {
      // Identity Sync: strict field mapping between access request and member profile
      const applicantFullName = (effectiveReq.fullName || effectiveReq.name || effectiveReq.email.split('@')[0]).trim();
      const applicantEmail = effectiveReq.email.trim().toLowerCase();

      // 1. Dynamic Onboarding: Populate directly into active Team Member List (Team Efficiency)
      setEmployees((prev) => {
        const existingIdx = prev.findIndex(
          (e) => (e.email || '').toLowerCase() === applicantEmail
        );
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = {
            ...updated[existingIdx],
            name: applicantFullName,
            email: applicantEmail,
            role: displayRole,
            discipline: targetDiscipline,
            primaryDiscipline: targetDiscipline,
            status: 'Active',
          };
          return updated;
        } else {
          const newEmp: Employee = {
            id: `emp-${Date.now()}`,
            name: applicantFullName,
            role: displayRole,
            email: applicantEmail,
            avatar:
              effectiveReq.avatar ||
              `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(applicantFullName)}`,
            primaryDiscipline: targetDiscipline,
            discipline: targetDiscipline,
            weeklyCapacityHours: 40,
            experienceYears: 4,
            status: 'Active',
            activeProjectIds: [projects[0]?.id || 'proj-1'],
            skills: [targetDiscipline, 'Revit 2026', 'Navisworks Manage', 'BIM Coordination'],
            phone: '+1 (555) 019-2834',
          };
          return [...prev, newEmp];
        }
      });

      // 2. Add Audit Log
      const newAudit: AdminAuditLog = {
        id: `audit-${Date.now()}`,
        action: 'approved',
        targetUserEmail: applicantEmail,
        targetUserName: applicantFullName,
        performedBy: `${SUPER_ADMIN_NAME} (Super Admin)`,
        timestamp: actionTimestamp,
        details: `Approved access request as ${displayRole} [${targetDiscipline}] with [${calculatedAccessLevel}] permissions. Added directly to active Team Member List.`,
      };
      setAuditLogs((prev) => [newAudit, ...prev]);

      // 3. Update current active user session if matching
      if (currentUser && currentUser.email.toLowerCase() === applicantEmail) {
        setCurrentUser((prev) =>
          prev
            ? {
                ...prev,
                status: 'APPROVED',
                role: displayRole,
                appRole: validatedRole,
                accessLevel: calculatedAccessLevel,
              }
            : null
        );
      }

      // 4. Persist status and assigned role in Firestore access_requests & users collection
      persistUserRoleToDatabase({
        email: applicantEmail,
        role: validatedRole,
        status: 'APPROVED',
        accessLevel: calculatedAccessLevel,
        name: applicantFullName,
        discipline: targetDiscipline,
        uid: effectiveReq.googleId || effectiveReq.id,
      }).catch((err) => {
        console.error('persistUserRoleToDatabase error in approve:', err);
      });
    }
  };

  const rejectOnboardingRequest = (requestId: string, notes?: string) => {
    let rejectedReq: OnboardingRequest | undefined;

    const actionTimestamp = new Date().toLocaleString([], {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    const reqTarget = onboardingRequests.find((r) => r.id === requestId);

    setOnboardingRequests((prev) =>
      prev.map((r) => {
        if (r.id === requestId || (reqTarget && r.email.toLowerCase() === reqTarget.email.toLowerCase())) {
          rejectedReq = {
            ...r,
            status: 'REJECTED',
            reviewedBy: `${SUPER_ADMIN_NAME} (Super Admin)`,
            reviewedAt: actionTimestamp,
            notes: notes || 'Access request rejected by Super Admin.',
          };
          return rejectedReq;
        }
        return r;
      })
    );

    const effectiveReq = rejectedReq || reqTarget;

    if (effectiveReq) {
      const applicantEmail = effectiveReq.email.trim().toLowerCase();
      const newAudit: AdminAuditLog = {
        id: `audit-${Date.now()}`,
        action: 'rejected',
        targetUserEmail: applicantEmail,
        targetUserName: effectiveReq.name,
        performedBy: `${SUPER_ADMIN_NAME} (Super Admin)`,
        timestamp: actionTimestamp,
        details: `Declined access request: ${notes || 'Access request declined by administrator.'}`,
      };
      setAuditLogs((prev) => [newAudit, ...prev]);

      // If user is registered in employees, suspend active status
      setEmployees((prev) =>
        prev.map((emp) =>
          emp.email.toLowerCase() === applicantEmail ||
          emp.id === effectiveReq.id ||
          (effectiveReq.googleId && emp.id === effectiveReq.googleId)
            ? { ...emp, status: 'Suspended' }
            : emp
        )
      );

      if (currentUser && currentUser.email.toLowerCase() === applicantEmail) {
        setCurrentUser((prev) => (prev ? { ...prev, status: 'REJECTED' } : null));
      }

      // Persist rejected status in Firestore access_requests & users collection
      persistUserRoleToDatabase({
        email: applicantEmail,
        role: (effectiveReq.assignedRole as UserRole) || 'VIEWER',
        status: 'REJECTED',
        name: effectiveReq.name,
        uid: effectiveReq.googleId || effectiveReq.id,
        notes: notes || 'Access request rejected by Super Admin.',
      }).catch((err) => {
        console.error('persistUserRoleToDatabase error in reject:', err);
      });
    }
  };

  const reopenOnboardingRequest = (requestId: string) => {
    let reopenedReq: OnboardingRequest | undefined;
    const actionTimestamp = new Date().toLocaleString([], {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    const reqTarget = onboardingRequests.find((r) => r.id === requestId);

    setOnboardingRequests((prev) =>
      prev.map((r) => {
        if (r.id === requestId || (reqTarget && r.email.toLowerCase() === reqTarget.email.toLowerCase())) {
          reopenedReq = {
            ...r,
            status: 'Pending',
            reviewedBy: undefined,
            reviewedAt: undefined,
            notes: 'Re-opened and restored to Pending Queue by Super Admin.',
          };
          return reopenedReq;
        }
        return r;
      })
    );

    const effectiveReq = reopenedReq || reqTarget;

    if (effectiveReq) {
      const applicantEmail = effectiveReq.email.trim().toLowerCase();
      const newAudit: AdminAuditLog = {
        id: `audit-${Date.now()}`,
        action: 'role_changed',
        targetUserEmail: applicantEmail,
        targetUserName: effectiveReq.name,
        performedBy: `${SUPER_ADMIN_NAME} (Super Admin)`,
        timestamp: actionTimestamp,
        details: `Re-opened declined access request for ${effectiveReq.name} (${applicantEmail}).`,
      };
      setAuditLogs((prev) => [newAudit, ...prev]);

      persistUserRoleToDatabase({
        email: applicantEmail,
        role: (effectiveReq.assignedRole as UserRole) || 'EDITOR',
        status: 'PENDING',
        name: effectiveReq.name,
        uid: effectiveReq.googleId || effectiveReq.id,
        notes: 'Re-opened and restored to Pending Queue by Super Admin.',
      }).catch((err) => {
        console.error('persistUserRoleToDatabase error in reopen:', err);
      });
    }
  };

  const deleteOnboardingRequest = (requestId: string) => {
    const matchedEmp = employees.find((e) => e.id === requestId);
    const target =
      onboardingRequests.find((r) => r.id === requestId) ||
      (matchedEmp
        ? onboardingRequests.find((r) => r.email.trim().toLowerCase() === matchedEmp.email.trim().toLowerCase())
        : undefined);

    const targetEmail = (target?.email || matchedEmp?.email || '').trim().toLowerCase();
    const targetName = target?.name || matchedEmp?.name || targetEmail;
    if (!target && !targetEmail) return;

    setOnboardingRequests((prev) =>
      prev.filter((r) => r.id !== requestId && (!targetEmail || r.email.trim().toLowerCase() !== targetEmail))
    );

    try {
      if (!requestId.startsWith('emp-')) {
        deleteDoc(doc(db, 'access_requests', requestId)).catch(() => {});
        deleteDoc(doc(db, 'users', requestId)).catch(() => {});
      }
      if (targetEmail) {
        const detId = generateRequestDocId(targetEmail);
        deleteDoc(doc(db, 'access_requests', detId)).catch(() => {});
        deleteDoc(doc(db, 'users', detId)).catch(() => {});
        getDocs(query(collection(db, 'access_requests'), where('email', '==', targetEmail)))
          .then((snap) => {
            snap.docs.forEach((d) => {
              deleteDoc(doc(db, 'access_requests', d.id)).catch(() => {});
            });
          })
          .catch(() => {});
        getDocs(query(collection(db, 'users'), where('email', '==', targetEmail)))
          .then((snap) => {
            snap.docs.forEach((d) => {
              deleteDoc(doc(db, 'users', d.id)).catch(() => {});
            });
          })
          .catch(() => {});
      }
    } catch {
      // ignore
    }

    const newAudit: AdminAuditLog = {
      id: `audit-${Date.now()}`,
      action: 'user_deleted',
      targetUserEmail: targetEmail || requestId,
      targetUserName: targetName,
      performedBy: `${SUPER_ADMIN_NAME} (Super Admin)`,
      timestamp: new Date().toLocaleString([], {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }),
      details: `Removed access request record for ${targetEmail || requestId}`,
    };
    setAuditLogs((prev) => [newAudit, ...prev]);

    if (currentUser && targetEmail && currentUser.email.toLowerCase() === targetEmail) {
      setCurrentUser(null);
    }
  };

  const addAuditLog = (log: Omit<AdminAuditLog, 'id' | 'timestamp'>) => {
    const timestamp = new Date().toLocaleString([], {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const newAudit: AdminAuditLog = {
      ...log,
      id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp,
    };
    setAuditLogs((prev) => [newAudit, ...prev]);
  };

  const setSimulatedAuthStatus = (status: UserApprovalStatus) => {
    setCurrentUser((prev) =>
      prev
        ? {
            ...prev,
            status,
          }
        : null
    );
  };

  const switchUser = (userUpdates: Partial<AuthUser>) => {
    setCurrentUser((prev) => {
      if (!prev) {
        return {
          id: 'emp-custom',
          email: userUpdates.email || 'user@productionpulse.com',
          name: userUpdates.name || 'BIM Member',
          role: userUpdates.role || 'BIM Modeler',
          status: userUpdates.status || 'active',
          isAdmin: !!userUpdates.isAdmin,
          accessLevel: userUpdates.accessLevel || 'Editor',
          ...userUpdates,
        };
      }
      return {
        ...prev,
        ...userUpdates,
      };
    });
  };

  const signOut = () => {
    if (auth) {
      auth.logout();
    }
    setCurrentUser(null);
    localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
    localStorage.removeItem('bim_auth_user_central_v1');
    localStorage.removeItem('bim_auth_session_central_v1');
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('bpms_redirect_target');
      window.history.pushState(null, '', '/');
      window.dispatchEvent(new Event('popstate'));
    }
  };

  // Project Helpers
  const getProjectById = (id: string) => projects.find((p) => p.id === id);
  const getEmployeeById = (id: string) => employees.find((e) => e.id === id);

  const getProjectCompletedHours = (projectId: string): number => {
    // Sum hours from all organizational workLogs for this project
    const logged = (allWorkLogs || [])
      .filter((w) => w.projectId === projectId)
      .reduce((sum, w) => sum + (Number(w.hoursLogged) || 0), 0);

    const project = getProjectById(projectId);
    if (
      project &&
      project.manualHoursOverride !== undefined &&
      project.manualHoursOverride !== null &&
      !Number.isNaN(Number(project.manualHoursOverride))
    ) {
      const baseLogged =
        project.manualHoursBaseLogged !== undefined && project.manualHoursBaseLogged !== null
          ? Number(project.manualHoursBaseLogged)
          : logged;
      const deltaLogged = logged - baseLogged;
      return Math.max(0, Number(project.manualHoursOverride) + deltaLogged);
    }

    const baseHours = project?.totalCompletedHours ?? 0;
    return Math.max(logged, baseHours);
  };

  const getEmployeeLoggedHours = (
    employeeId: string,
    filterRange: string = 'this-week'
  ): number => {
    const strippedEmpId = (employeeId || '').trim().replace(/^emp-/, '');
    const emp = employees.find(
      (e) =>
        e.id === employeeId ||
        (e.id || '').replace(/^emp-/, '') === strippedEmpId
    );
    const empName = (emp?.name || '').toLowerCase().trim();
    const empEmail = (emp?.email || '').toLowerCase().trim();
    const detEmailId = empEmail ? generateRequestDocId(empEmail) : '';

    const matchesMember = (item: {
      employeeId?: string;
      userId?: string;
      employeeName?: string;
      memberEmail?: string;
      userEmail?: string;
    }): boolean => {
      const itemEmpId = (item.employeeId || '').trim();
      const itemEmpIdStripped = itemEmpId.replace(/^emp-/, '');
      const itemUserId = (item.userId || '').trim();
      const itemUserIdStripped = itemUserId.replace(/^emp-/, '');
      const itemEmail = (item.memberEmail || item.userEmail || '').toLowerCase().trim();
      const itemName = (item.employeeName || '').toLowerCase().trim();

      if (
        (employeeId && (itemEmpId === employeeId || itemUserId === employeeId)) ||
        (strippedEmpId &&
          (itemEmpIdStripped === strippedEmpId || itemUserIdStripped === strippedEmpId)) ||
        (detEmailId &&
          (itemEmpIdStripped === detEmailId || itemUserIdStripped === detEmailId))
      ) {
        return true;
      }
      if (empEmail && itemEmail && empEmail === itemEmail) {
        return true;
      }
      if (empName && itemName && empName === itemName) {
        return true;
      }
      return false;
    };

    const weekRange = getCurrentWeekRange();
    const todayIso = toLocalIsoDate(new Date());

    const matchingLogs = (allWorkLogs || []).filter((w) => matchesMember(w));

    if (filterRange === 'all') {
      return matchingLogs.reduce((sum, l) => sum + (Number(l.hoursLogged) || 0), 0);
    }

    if (filterRange === 'today') {
      return matchingLogs
        .filter((w) => getEffectiveLogDate(w, weekRange) === todayIso)
        .reduce((sum, l) => sum + (Number(l.hoursLogged) || 0), 0);
    }

    if (filterRange === 'this-month') {
      const now = new Date();
      return matchingLogs
        .filter((w) => {
          const effDate = getEffectiveLogDate(w, weekRange);
          const logDate = new Date(`${effDate}T00:00:00`);
          return (
            !Number.isNaN(logDate.getTime()) &&
            logDate.getMonth() === now.getMonth() &&
            logDate.getFullYear() === now.getFullYear()
          );
        })
        .reduce((sum, l) => sum + (Number(l.hoursLogged) || 0), 0);
    }

    // Default: 'this-week' -> Global Real-Time Weekly Capacity Load calculation
    // Dynamically aggregate and sum the user's assigned hours (from project_assignments)
    // and/or logged hours for the current week (from work_logs).
    const currentWeekLogs = matchingLogs.filter((w) => {
      const effDate = getEffectiveLogDate(w, weekRange);
      return effDate >= weekRange.startIso && effDate <= weekRange.endIso;
    });

    const weeklyLoggedHours = (currentWeekLogs.length > 0 ? currentWeekLogs : matchingLogs).reduce(
      (sum, l) => sum + (Number(l.hoursLogged) || 0),
      0
    );

    const matchingAllocations = (resourceAllocations || []).filter(
      (a) => a.status !== 'Completed' && matchesMember(a)
    );

    const weeklyAssignedHours = matchingAllocations.reduce(
      (sum, a) => sum + (Number(a.assignedHours) || 0),
      0
    );

    if (weeklyAssignedHours > 0 && weeklyLoggedHours > 0) {
      // Aggregate per-project maximum of assigned vs logged hours so unallocated project logs add onto assigned capacity
      const normProj = (pid?: string) =>
        (pid || '').startsWith('proj-') ? (pid || '') : (pid || '').replace(/^p(\d+)$/, 'proj-$1');
      const byProject = new Map<string, { assigned: number; logged: number }>();

      matchingAllocations.forEach((a) => {
        const key = normProj(a.projectId) || '__unassigned__';
        const cur = byProject.get(key) || { assigned: 0, logged: 0 };
        cur.assigned += Number(a.assignedHours) || 0;
        byProject.set(key, cur);
      });

      const activeLogsForWeek = currentWeekLogs.length > 0 ? currentWeekLogs : matchingLogs;
      activeLogsForWeek.forEach((l) => {
        const key = normProj(l.projectId) || '__unassigned__';
        const cur = byProject.get(key) || { assigned: 0, logged: 0 };
        cur.logged += Number(l.hoursLogged) || 0;
        byProject.set(key, cur);
      });

      let combinedTotal = 0;
      byProject.forEach(({ assigned, logged }) => {
        combinedTotal += Math.max(assigned, logged);
      });
      return combinedTotal;
    }

    return weeklyAssignedHours > 0 ? weeklyAssignedHours : weeklyLoggedHours;
  };

  // Actions
  const addProject = (projectData: Omit<BimProject, 'id'>): BimProject => {
    const newProj: BimProject = {
      ...projectData,
      id: `proj-${Date.now()}`,
      status: projectData.status || 'WIP',
      totalEstimatedHours: Number(projectData.totalEstimatedHours) || 0,
      totalCompletedHours: Number(projectData.totalCompletedHours) || 0,
      plannedDeliveryDate:
        projectData.plannedDeliveryDate ||
        projectData.targetCompletionDate ||
        new Date().toISOString().slice(0, 10),
    };

    // Immediate optimistic update so all views and dropdowns reflect the new project right away
    setProjects((prev) => [newProj, ...prev.filter((p) => p.id !== newProj.id)]);

    try {
      // Strip undefined values so Firestore setDoc never rejects optional fields
      const sanitizedProj = JSON.parse(JSON.stringify(newProj));
      const firestorePayload = {
        ...sanitizedProj,
        projectName: newProj.name,
        status: newProj.status || 'WIP',
        estimatedHours: Number(newProj.totalEstimatedHours) || 0,
        totalHoursLogged: Number(newProj.totalCompletedHours) || 0,
        plannedDeliveryDate:
          newProj.plannedDeliveryDate ||
          newProj.targetCompletionDate ||
          new Date().toISOString().slice(0, 10),
        createdAt: serverTimestamp(),
      };
      setDoc(doc(db, 'projects', newProj.id), firestorePayload, { merge: true }).catch((err) =>
        console.warn('Firestore addProject sync notice:', err)
      );
    } catch (e) {
      console.warn('Firestore addProject notice:', e);
    }
    return newProj;
  };

  const updateProject = (id: string, updates: Partial<BimProject>) => {
    let updatedDoc: BimProject | undefined;
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id === id) {
          updatedDoc = { ...p, ...updates };
          return updatedDoc;
        }
        return p;
      })
    );
    try {
      const base = updatedDoc ? { ...updatedDoc, ...updates } : { id, ...updates };
      const sanitizedPayload = JSON.parse(JSON.stringify(base));
      if (sanitizedPayload.name !== undefined) {
        sanitizedPayload.projectName = sanitizedPayload.name;
      }
      if (sanitizedPayload.totalEstimatedHours !== undefined) {
        sanitizedPayload.estimatedHours = Number(sanitizedPayload.totalEstimatedHours) || 0;
      }
      if (sanitizedPayload.totalCompletedHours !== undefined) {
        sanitizedPayload.totalHoursLogged = Number(sanitizedPayload.totalCompletedHours) || 0;
      }
      setDoc(doc(db, 'projects', id), sanitizedPayload, { merge: true }).catch((err) =>
        console.warn('Firestore updateProject sync notice:', err)
      );
    } catch (e) {
      console.warn('Firestore updateProject notice:', e);
    }
  };

  const updateProjectStatus = (id: string, status: BimProject['status']) => {
    let updatedDoc: BimProject | undefined;
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id === id) {
          updatedDoc = { ...p, status };
          return updatedDoc;
        }
        return p;
      })
    );
    try {
      const payload = updatedDoc ? { ...updatedDoc, status } : { id, status };
      const sanitizedPayload = JSON.parse(JSON.stringify(payload));
      setDoc(doc(db, 'projects', id), sanitizedPayload, { merge: true }).catch((err) =>
        console.warn('Firestore updateProjectStatus sync notice:', err)
      );
    } catch (e) {
      console.warn('Firestore updateProjectStatus notice:', e);
    }
  };

  const deleteProject = (id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id));
    setAllWorkLogs((prev) => prev.filter((w) => w.projectId !== id));
    if (selectedProjectId === id) {
      setSelectedProjectId('all');
    }
    try {
      deleteDoc(doc(db, 'projects', id)).catch((err) =>
        console.warn('Firestore deleteProject sync notice:', err)
      );
    } catch (e) {
      console.warn('Firestore deleteProject notice:', e);
    }
  };

  const addWorkLog = (
    logData: Omit<DailyWorkLog, 'id' | 'timestamp'>
  ): DailyWorkLog => {
    const logId = `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const userEmail = (
      logData.memberEmail ||
      (logData as any).userEmail ||
      currentUser?.email ||
      ''
    )
      .trim()
      .toLowerCase();
    const userId =
      (logData as any).userId ||
      currentUser?.id ||
      (userEmail ? generateRequestDocId(userEmail) : '') ||
      logData.employeeId ||
      '';
    const hoursValue = Number(logData.hoursLogged) || 0;

    const newLog: DailyWorkLog = {
      ...logData,
      id: logId,
      hoursLogged: hoursValue,
      memberEmail: userEmail,
      userEmail: userEmail,
      userId: userId,
      timestamp: new Date().toISOString(),
    };

    // 1. Optimistic state update in allWorkLogs
    setAllWorkLogs((prev) => [newLog, ...prev.filter((w) => w.id !== logId)]);

    // 2. Persist to central Firestore work_logs collection
    try {
      const logDoc = doc(db, 'work_logs', logId);
      const sanitizedLog = JSON.parse(JSON.stringify(newLog));
      setDoc(logDoc, sanitizedLog, { merge: true }).catch((err) =>
        console.warn('Firestore addWorkLog sync notice:', err)
      );
    } catch (fsErr) {
      console.warn('Firestore addWorkLog error:', fsErr);
    }

    // 3. Update project task completed hours if applicable
    setProjects((prev) =>
      prev.map((proj) => {
        if (proj.id !== logData.projectId) return proj;
        const updatedTasks = proj.tasks.map((task) => {
          if (task.name === logData.taskName) {
            const newCompleted = (task.completedHours || 0) + hoursValue;
            return {
              ...task,
              completedHours: newCompleted,
              status:
                newCompleted >= task.estimatedHours
                  ? ('Completed' as const)
                  : ('In Progress' as const),
            };
          }
          return task;
        });
        const updatedProj = { ...proj, tasks: updatedTasks };
        try {
          updateDoc(doc(db, 'projects', proj.id), { tasks: updatedTasks }).catch(() => {});
        } catch {}
        return updatedProj;
      })
    );

    return newLog;
  };

  const updateWorkLog = (id: string, updates: Partial<DailyWorkLog>) => {
    setAllWorkLogs((prev) =>
      prev.map((w) => (w.id === id ? { ...w, ...updates } : w))
    );
    try {
      const sanitizedUpdates = JSON.parse(JSON.stringify(updates));
      updateDoc(doc(db, 'work_logs', id), sanitizedUpdates).catch((err) =>
        console.warn('Firestore updateWorkLog sync notice:', err)
      );
    } catch (e) {
      console.warn('Firestore updateWorkLog notice:', e);
    }
  };

  const deleteWorkLog = (id: string) => {
    setAllWorkLogs((prev) => prev.filter((w) => w.id !== id));
    try {
      deleteDoc(doc(db, 'work_logs', id)).catch((err) =>
        console.warn('Firestore deleteWorkLog sync notice:', err)
      );
    } catch (e) {
      console.warn('Firestore deleteWorkLog notice:', e);
    }
  };

  const addEmployee = (empData: Omit<Employee, 'id'>): Employee => {
    const newEmp: Employee = {
      ...empData,
      id: `emp-${Date.now()}`,
    };
    setEmployees((prev) => [...prev, newEmp]);
    return newEmp;
  };

  const updateEmployee = (id: string, updates: Partial<Employee>) => {
    setEmployees((prev) =>
      prev.map((e) => (e.id === id ? { ...e, ...updates } : e))
    );
  };

  const deleteEmployee = (id: string) => {
    const targetEmp = employees.find((e) => e.id === id);
    const targetName = targetEmp ? targetEmp.name.toLowerCase().trim() : '';
    const targetEmail = targetEmp ? targetEmp.email.toLowerCase().trim() : '';

    // 1. Remove from active employees state
    setEmployees((prev) =>
      prev.filter((e) => e.id !== id && (!targetEmail || e.email.toLowerCase() !== targetEmail))
    );

    // 2. Cascade cleanup on projects: unlink member from project assignments and active task allocations
    setProjects((prev) =>
      prev.map((p) => ({
        ...p,
        assignedEmployeeIds: p.assignedEmployeeIds.filter((empId) => empId !== id),
        tasks: p.tasks.filter((t) => t.assignedEmployeeId !== id),
        clashes: p.clashes.map((c) =>
          c.assignedToEmployeeId === id ? { ...c, assignedToEmployeeId: '' } : c
        ),
      }))
    );

    // 3. Cascade cleanup on workLogs: remove timesheet logs for deleted member
    setAllWorkLogs((prev) =>
      prev.filter(
        (log) =>
          log.employeeId !== id &&
          (!targetName || log.employeeName.toLowerCase().trim() !== targetName) &&
          (!targetEmail || ((log as any).memberEmail || '').toLowerCase().trim() !== targetEmail)
      )
    );

    // 4. Cascade cleanup on resource allocations in localStorage
    try {
      const savedAlloc = localStorage.getItem('bim_resource_allocations_v1');
      if (savedAlloc) {
        const parsed = JSON.parse(savedAlloc);
        if (Array.isArray(parsed)) {
          const filtered = parsed.filter(
            (a) =>
              a.employeeId !== id &&
              (!targetName || (a.employeeName || '').toLowerCase().trim() !== targetName) &&
              (!targetEmail || ((a as any).memberEmail || '').toLowerCase().trim() !== targetEmail)
          );
          localStorage.setItem('bim_resource_allocations_v1', JSON.stringify(filtered));
          window.dispatchEvent(new CustomEvent('bim_resource_allocations_updated', { detail: filtered }));
        }
      }
    } catch (e) {
      console.warn('Cascade allocation cleanup notice:', e);
    }

    // 5. Add audit log
    if (targetEmp) {
      const newAudit: AdminAuditLog = {
        id: `audit-${Date.now()}`,
        action: 'user_deleted',
        targetUserEmail: targetEmp.email,
        targetUserName: targetEmp.name,
        performedBy: `${SUPER_ADMIN_NAME} (Super Admin)`,
        timestamp: new Date().toLocaleString([], {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }),
        details: `Deleted team member ${targetEmp.name} (${targetEmp.email}). Cascaded cleanup across task allocations, timesheets, and project teams.`,
      };
      setAuditLogs((prev) => [newAudit, ...prev]);
    }
  };

  const addMilestone = (projectId: string, milestone: Omit<Milestone, 'id'>) => {
    const newMs: Milestone = {
      ...milestone,
      id: `ms-${Date.now()}`,
    };
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId
          ? { ...p, milestones: [...p.milestones, newMs] }
          : p
      )
    );
  };

  const updateMilestoneStatus = (
    projectId: string,
    milestoneId: string,
    status: Milestone['status']
  ) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        const updatedMs = p.milestones.map((m) =>
          m.id === milestoneId
            ? {
                ...m,
                status,
                completionDate:
                  status === 'completed' ? '2026-08-18' : m.completionDate,
              }
            : m
        );
        return { ...p, milestones: updatedMs };
      })
    );
  };

  const addClash = (projectId: string, clash: Omit<ClashRecord, 'id'>) => {
    const newClash: ClashRecord = {
      ...clash,
      id: `clash-${Date.now()}`,
    };
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId ? { ...p, clashes: [newClash, ...p.clashes] } : p
      )
    );
  };

  const updateClashStatus = (
    projectId: string,
    clashId: string,
    status: ClashRecord['status']
  ) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        const updated = p.clashes.map((c) =>
          c.id === clashId
            ? {
                ...c,
                status,
                resolvedDate:
                  status === 'Resolved' ? '2026-08-18' : c.resolvedDate,
              }
            : c
        );
        return { ...p, clashes: updated };
      })
    );
  };

  const addTask = (
    projectId: string,
    task: Omit<TaskItem, 'id' | 'projectId'>
  ) => {
    const newTask: TaskItem = {
      ...task,
      id: `tsk-${Date.now()}`,
      projectId,
    };
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId ? { ...p, tasks: [...p.tasks, newTask] } : p
      )
    );
  };

  const updateTask = (
    projectId: string,
    taskId: string,
    updates: Partial<TaskItem>
  ) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id !== projectId) return p;
        const updated = p.tasks.map((t) =>
          t.id === taskId ? { ...t, ...updates } : t
        );
        return { ...p, tasks: updated };
      })
    );
  };

  const saveStakeholderReport = (report: GeneratedStakeholderReport) => {
    setGeneratedReports((prev) => [report, ...prev]);
  };

  const resetToMockData = () => {
    setProjects(INITIAL_PROJECTS);
    setEmployees([]);
    setAllWorkLogs([]);
    setGeneratedReports([]);
    localStorage.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(INITIAL_PROJECTS));
    localStorage.removeItem(STORAGE_KEYS.EMPLOYEES);
    localStorage.removeItem(STORAGE_KEYS.WORK_LOGS);
    localStorage.removeItem(STORAGE_KEYS.REPORTS);
    localStorage.removeItem('bim_resource_allocations_v2');
    localStorage.removeItem('bim_project_feedbacks_v2');
    window.dispatchEvent(new CustomEvent('bim_resource_allocations_updated', { detail: [] }));
    window.dispatchEvent(new Event('bim_feedback_updated'));
  };

  // Overall Computed Metrics
  const overallMetrics = useMemo(() => {
    const targetProjects =
      selectedProjectId === 'all'
        ? projects
        : projects.filter((p) => p.id === selectedProjectId);

    const totalEstimated = targetProjects.reduce(
      (sum, p) => sum + p.totalEstimatedHours,
      0
    );

    const totalCompleted = targetProjects.reduce((sum, p) => {
      return sum + getProjectCompletedHours(p.id);
    }, 0);

    const hoursVariance = totalEstimated - totalCompleted;
    const completionPercentage =
      totalEstimated > 0
        ? Math.min(100, Math.round((totalCompleted / totalEstimated) * 100))
        : 0;

    let criticalClashes = 0;
    let totalClashes = 0;
    let resolvedClashes = 0;

    targetProjects.forEach((p) => {
      p.clashes.forEach((c) => {
        totalClashes++;
        if (c.severity === 'Critical' && c.status !== 'Resolved') {
          criticalClashes++;
        }
        if (c.status === 'Resolved') {
          resolvedClashes++;
        }
      });
    });

    // Employee capacity utilization (logged hours in current week / capacity)
    const totalWeeklyCapacity = employees.length * 40;
    const totalLoggedThisWeek = employees.reduce(
      (sum, emp) => sum + getEmployeeLoggedHours(emp.id, 'this-week'),
      0
    );
    const avgUtilizationRate =
      totalWeeklyCapacity > 0
        ? Math.round((totalLoggedThisWeek / totalWeeklyCapacity) * 100)
        : 0;

    return {
      totalEstimatedHours: totalEstimated,
      totalCompletedHours: totalCompleted,
      hoursVariance,
      completionPercentage,
      activeProjectsCount: targetProjects.length,
      totalEmployeesCount: employees.length,
      criticalClashesCount: criticalClashes,
      totalClashesCount: totalClashes,
      resolvedClashesCount: resolvedClashes,
      avgUtilizationRate,
    };
  }, [projects, employees, workLogs, allWorkLogs, resourceAllocations, selectedProjectId]);

  return (
    <BimDataContext.Provider
      value={{
        projects,
        employees,
        workLogs,
        generatedReports,
        savedReports: generatedReports,
        selectedProjectId,
        setSelectedProjectId,
        currentTab,
        setCurrentTab,
        dateFilter,
        setDateFilter,
        globalSearchQuery,
        setGlobalSearchQuery,
        theme,
        setTheme,
        toggleTheme,
        currentUser,
        setCurrentUser,
        onboardingRequests,
        setOnboardingRequests,
        registerAccessRequest,
        auditLogs,
        setAuditLogs,
        addAuditLog,
        signInWithGoogle,
        signInWithEmail,
        requestAccess,
        updateAccessRequestReason,
        checkUserStatus,
        approveOnboardingRequest,
        rejectOnboardingRequest,
        reopenOnboardingRequest,
        deleteOnboardingRequest,
        setSimulatedAuthStatus,
        switchUser,
        signOut,
        addProject,
        updateProject,
        updateProjectStatus,
        deleteProject,
        addWorkLog,
        updateWorkLog,
        deleteWorkLog,
        addEmployee,
        updateEmployee,
        deleteEmployee,
        addMilestone,
        updateMilestoneStatus,
        addClash,
        updateClashStatus,
        addTask,
        updateTask,
        saveStakeholderReport,
        resetToMockData,
        getProjectById,
        getEmployeeById,
        getProjectCompletedHours,
        getEmployeeLoggedHours,
        overallMetrics,
      }}
    >
      {children}
    </BimDataContext.Provider>
  );
};

export const useBimData = () => {
  const context = useContext(BimDataContext);
  if (!context) {
    throw new Error('useBimData must be used within a BimDataProvider');
  }
  return context;
};
