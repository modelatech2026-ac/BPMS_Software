import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import {
  BimProject,
  Employee,
  DailyWorkLog,
  GeneratedStakeholderReport,
  ViewTab,
  Discipline,
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
} from '../types';
import {
  INITIAL_PROJECTS,
  INITIAL_EMPLOYEES,
  generateInitialWorkLogs,
} from '../data/mockData';
import {
  SUPER_ADMIN_EMAIL,
  SUPER_ADMIN_NAME,
  mapAppRoleToAccessLevel,
  mapAppRoleToDisplayRole,
} from '../auth/googleAuth';
import { useOptionalAuth } from '../auth/AuthContext';
import { db } from '../firebase/config';
import { collection, doc, onSnapshot, updateDoc, setDoc, getDocs } from 'firebase/firestore';

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
    uid?: string;
    organization?: string;
    accessReason?: string;
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
  PROJECTS: 'bim_tracker_projects_v5',
  EMPLOYEES: 'bim_tracker_employees_v5',
  WORK_LOGS: 'bim_tracker_worklogs_v5',
  REPORTS: 'bim_tracker_reports_v5',
  USER_ACCESS: 'bim_tracker_user_access_v5',
  THEME: 'bim_tracker_theme_v5',
  CURRENT_USER: 'bim_tracker_current_user_v5',
  ONBOARDING: 'bim_tracker_onboarding_v5',
  AUDIT_LOGS: 'bim_tracker_audit_logs_v5',
};

const DEFAULT_CURRENT_USER: AuthUser = {
  id: 'usr_super_admin_sushoovan',
  googleId: 'google_super_admin_sushoovan',
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

export const BimDataProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [projects, setProjects] = useState<BimProject[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.PROJECTS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
      return INITIAL_PROJECTS;
    } catch {
      return INITIAL_PROJECTS;
    }
  });

  // Helper to strictly retain Sushovan and Aditi (plus dynamically approved access requests)
  const isRetainedMember = (emp: { id?: string; name?: string; email?: string }): boolean => {
    if (!emp) return false;
    const email = (emp.email || '').toLowerCase().trim();
    const name = (emp.name || '').toLowerCase().trim();
    const id = emp.id || '';

    // Retain Sushovan Das (sushovan.das@bimworkspace.com)
    if (
      email === 'sushovan.das@bimworkspace.com' ||
      name.includes('sushovan') ||
      name.includes('sushoovan') ||
      id === 'emp-2'
    ) {
      return true;
    }

    // Retain Aditi
    if (
      email.includes('aditi') ||
      name.includes('aditi') ||
      id === 'emp-aditi'
    ) {
      return true;
    }

    return false;
  };

  const [employees, setEmployees] = useState<Employee[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.EMPLOYEES);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Filter to strictly retain Sushovan and Aditi (plus any dynamically approved requests)
          const filtered = parsed.filter(isRetainedMember);
          const hasSushovan = filtered.some(e => (e.email || '').toLowerCase() === 'sushovan.das@bimworkspace.com' || (e.name || '').toLowerCase().includes('sushovan'));
          const hasAditi = filtered.some(e => (e.name || '').toLowerCase().includes('aditi') || (e.email || '').toLowerCase().includes('aditi'));
          const initialSushovan = INITIAL_EMPLOYEES.find(e => (e.email || '').toLowerCase() === 'sushovan.das@bimworkspace.com') || INITIAL_EMPLOYEES[0];
          const initialAditi = INITIAL_EMPLOYEES.find(e => (e.name || '').toLowerCase().includes('aditi')) || INITIAL_EMPLOYEES[1];
          const result = [...filtered];
          if (!hasSushovan && initialSushovan) result.unshift(initialSushovan);
          if (!hasAditi && initialAditi) result.push(initialAditi);
          return result;
        }
      }
      return INITIAL_EMPLOYEES;
    } catch {
      return INITIAL_EMPLOYEES;
    }
  });

  const [workLogs, setWorkLogs] = useState<DailyWorkLog[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.WORK_LOGS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const filtered = parsed.filter((log: DailyWorkLog) => {
            const name = (log.employeeName || '').toLowerCase();
            const id = log.employeeId || '';
            return name.includes('sushovan') || name.includes('sushoovan') || name.includes('aditi') || id === 'emp-2' || id === 'emp-aditi';
          });
          if (filtered.length > 0) return filtered;
        }
      }
      return generateInitialWorkLogs();
    } catch {
      return generateInitialWorkLogs();
    }
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

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.WORK_LOGS, JSON.stringify(workLogs));
  }, [workLogs]);

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

    const mapDocToRequest = (d: any): OnboardingRequest | null => {
      const data = d.data();
      if (!data || !data.email) return null;
      const rawStatus = (data.status || 'pending').toLowerCase();
      const mappedStatus: UserApprovalStatus =
        rawStatus === 'approved'
          ? 'APPROVED'
          : rawStatus === 'rejected'
          ? 'REJECTED'
          : 'pending';
      const fullName = data.fullName || data.name || data.email.split('@')[0];
      const discipline = data.discipline || data.primaryDiscipline || data.organization || 'BIM - ACS';
      const reasonForAccess = data.reasonForAccess || data.accessReason || 'Sign-in Access Request for ProductionPulse BPMS';
      const createdAt = data.createdAt || data.requestedAt || data.timestamp || new Date().toISOString();

      return {
        id: d.id,
        googleId: data.uid || d.id,
        email: data.email,
        name: fullName,
        fullName: fullName,
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(fullName)}`,
        role: data.role || 'Editor',
        requestedRole: data.requestedRole || data.role || 'BIM Modeler / Editor',
        primaryDiscipline: discipline,
        discipline: discipline,
        organization: discipline,
        reasonForAccess: reasonForAccess,
        accessReason: reasonForAccess,
        createdAt: createdAt,
        requestedAt: createdAt,
        requestTimestamp: createdAt,
        timestamp: createdAt,
        status: rawStatus === 'pending' ? 'pending' : mappedStatus,
        reviewedBy: data.reviewedBy,
        reviewedAt: data.reviewedAt,
        notes: data.notes || 'Sign-in access request awaiting Super Admin review in Admin Nexus.',
      };
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
              }
            });
            return changed ? updated : currentEmployees;
          });
        }
      };

      // Initial active fetch from Firestore
      getDocs(colRef)
        .then((snapshot) => {
          const list = snapshot.docs.map(mapDocToRequest).filter(Boolean) as OnboardingRequest[];
          setOnboardingRequests(list);
          syncApprovedToEmployees(list);
        })
        .catch((err) => {
          console.warn('Initial access_requests fetch notice:', err);
        });

      // Real-time onSnapshot listener
      unsubscribe = onSnapshot(
        colRef,
        (snapshot) => {
          const list = snapshot.docs.map(mapDocToRequest).filter(Boolean) as OnboardingRequest[];
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

    // 2. Check if user was already approved in employees roster
    const matchedEmployee = employees.find(
      (e) => e.email.toLowerCase() === trimmedEmail
    );

    if (matchedEmployee) {
      const activeUser: AuthUser = {
        id: matchedEmployee.id,
        googleId: profile.googleId,
        email: matchedEmployee.email,
        name: matchedEmployee.name,
        role: matchedEmployee.role,
        appRole: 'EDITOR',
        status: 'APPROVED',
        isAdmin: false,
        accessLevel: 'Editor',
        avatar: profile.picture || matchedEmployee.avatar,
        organization: profile.organization || 'BPMS Production Team',
        requestTimestamp: '2026-08-23 09:00 AM',
      };
      setCurrentUser(activeUser);
      return { status: 'APPROVED', user: activeUser };
    }

    // 3. Check existing onboarding requests
    const existingReq = onboardingRequests.find(
      (r) => r.email.toLowerCase() === trimmedEmail
    );

    if (existingReq) {
      const authUser: AuthUser = {
        id: existingReq.id,
        googleId: profile.googleId || existingReq.googleId,
        email: existingReq.email,
        name: profile.name || existingReq.name,
        role: existingReq.requestedRole,
        appRole: (existingReq.assignedRole as UserRole) || 'VIEWER',
        status: existingReq.status,
        isAdmin: existingReq.assignedRole === 'SUPER_ADMIN',
        accessLevel: existingReq.assignedAccessLevel || (existingReq.status === 'APPROVED' || existingReq.status === 'approved' ? 'Editor' : 'Viewer'),
        avatar: profile.picture || existingReq.avatar,
        organization: existingReq.organization || profile.organization || 'ProductionPulse Partner Network',
        accessReason: existingReq.accessReason || profile.accessReason || existingReq.notes,
        requestTimestamp: existingReq.requestTimestamp,
      };

      // Ensure employee entry is also synchronized
      const existingEmp = employees.find(
        (e) => e.email.toLowerCase() === trimmedEmail
      );
      if (!existingEmp) {
        const newEmp: Employee = {
          id: `emp-${Date.now()}`,
          name: authUser.name,
          email: trimmedEmail,
          role: authUser.role || 'Viewer (Google SSO)',
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

      setCurrentUser(authUser);
      return { status: existingReq.status, user: authUser };
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
    const newRequest: OnboardingRequest = {
      id: `req-${Date.now()}`,
      googleId: profile.googleId,
      email: trimmedEmail,
      name: formattedName,
      avatar: profile.picture || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(formattedName)}`,
      role: 'Editor',
      requestedRole: 'BIM Modeler / Specialist',
      primaryDiscipline: (profile.discipline as Discipline) || 'BIM - ACS',
      requestedAt: isoTimestamp,
      requestTimestamp: timestamp,
      timestamp: isoTimestamp,
      status: 'pending',
      organization: profile.organization || 'Google Workspace Authenticated Partner',
      accessReason: profile.accessReason || 'BIM Model Review, coordination, and production tracking access.',
      notes: 'Authenticated via Google OAuth (Gmail). Awaiting Super Admin review in Nexus Admin Panel.',
    };

    setOnboardingRequests((prev) => [newRequest, ...prev.filter((r) => r.email.toLowerCase() !== trimmedEmail)]);

    // Save to Firestore access_requests collection (No LocalStorage fallback)
    try {
      const reqDoc = doc(db, 'access_requests', newRequest.id);
      setDoc(
        reqDoc,
        {
          fullName: formattedName,
          email: trimmedEmail,
          discipline: (profile.discipline as Discipline) || 'BIM - ACS',
          reasonForAccess: profile.accessReason || 'BIM Model review & coordination',
          status: 'pending',
          createdAt: isoTimestamp,
          id: newRequest.id,
          uid: newRequest.id,
          name: formattedName,
          role: 'Editor',
          requestedAt: isoTimestamp,
          timestamp: isoTimestamp,
          requestedRole: 'BIM Modeler / Specialist',
          primaryDiscipline: (profile.discipline as Discipline) || 'BIM - ACS',
          organization: profile.organization || 'Google Workspace Partner',
          accessReason: profile.accessReason || 'BIM Model review & coordination',
        },
        { merge: true }
      ).catch(() => {});
    } catch {
      // ignore
    }

    // Directly register in employees roster so they immediately show in Active Team & Permissions
    const existingEmp = employees.find(
      (e) => e.email.toLowerCase() === trimmedEmail
    );
    if (!existingEmp) {
      const newEmp: Employee = {
        id: `emp-${Date.now()}`,
        name: formattedName,
        email: trimmedEmail,
        role: 'Viewer (Google SSO Pending)',
        avatar: newRequest.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(formattedName)}`,
        primaryDiscipline: (profile.discipline as Discipline) || 'BIM - ACS',
        discipline: (profile.discipline as Discipline) || 'BIM - ACS',
        weeklyCapacityHours: 40,
        status: 'Active',
        activeProjectIds: [projects[0]?.id || 'proj-1'],
        skills: ['Revit 2026', 'Navisworks Manage', 'BIM 360'],
      };
      setEmployees((prev) => [...prev, newEmp]);
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
      currentUser.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase() ||
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
  }): Promise<OnboardingRequest> => {
    const trimmedEmail = params.email.trim().toLowerCase();
    const formattedName = (params.fullName || params.name || '').trim() || trimmedEmail.split('@')[0];
    const requestId = params.uid || `req_${trimmedEmail.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;
    const timestamp = new Date().toLocaleString([], {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    const isoTimestamp = new Date().toISOString();
    const assignedRole = 'Editor';
    const discipline = params.discipline || params.organization || 'BIM - ACS';
    const reasonForAccess = params.reasonForAccess || params.accessReason || 'Sign-in Access Request for ProductionPulse BPMS';

    const newRequest: OnboardingRequest = {
      id: requestId,
      googleId: requestId,
      email: trimmedEmail,
      name: formattedName,
      fullName: formattedName,
      avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(formattedName)}`,
      role: assignedRole,
      requestedRole: 'BIM Modeler / Editor',
      primaryDiscipline: discipline,
      discipline: discipline,
      createdAt: isoTimestamp,
      requestedAt: isoTimestamp,
      requestTimestamp: timestamp,
      timestamp: isoTimestamp,
      status: 'pending',
      organization: discipline,
      reasonForAccess: reasonForAccess,
      accessReason: reasonForAccess,
      notes: 'Submitted via sign-in access gateway. Awaiting Super Admin review in Admin Nexus.',
    };

    // 1. Immediately update in-memory React state
    setOnboardingRequests((prev) => [
      newRequest,
      ...prev.filter((r) => r.email.toLowerCase() !== trimmedEmail && r.id !== requestId),
    ]);

    // 2. Immediately log to Admin Audit Trail
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

    // 3. Save to central database collection Firestore access_requests (No LocalStorage)
    try {
      const reqDoc = doc(db, 'access_requests', requestId);
      await setDoc(
        reqDoc,
        {
          fullName: formattedName,
          email: trimmedEmail,
          discipline,
          reasonForAccess,
          status: 'pending',
          createdAt: isoTimestamp,
          id: requestId,
          uid: requestId,
          name: formattedName,
          role: assignedRole,
          requestedRole: 'BIM Modeler / Editor',
          primaryDiscipline: discipline,
          organization: discipline,
          accessReason: reasonForAccess,
          requestedAt: isoTimestamp,
          timestamp: isoTimestamp,
          requestTimestamp: timestamp,
        },
        { merge: true }
      );
    } catch (fsErr) {
      console.warn('Firestore setDoc notice for sign-in request:', fsErr);
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
      assignedRole === 'SUPER_ADMIN' || assignedRole === 'PROJECT_MANAGER' || assignedRole === 'EDITOR' || assignedRole === 'VIEWER'
        ? assignedRole
        : 'EDITOR';

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
        if (r.id === requestId) {
          approvedReq = {
            ...r,
            status: 'APPROVED',
            reviewedBy: `${SUPER_ADMIN_NAME} (Super Admin)`,
            reviewedAt: actionTimestamp,
            assignedRole: validatedRole,
            assignedAccessLevel: calculatedAccessLevel,
            requestedRole: displayRole,
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
      const applicantEmail = effectiveReq.email.trim();

      // 1. Dynamic Onboarding: Populate directly into active Team Member List (Team Efficiency)
      setEmployees((prev) => {
        const existingIdx = prev.findIndex(
          (e) => (e.email || '').toLowerCase() === applicantEmail.toLowerCase()
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
      if (currentUser && currentUser.email.toLowerCase() === applicantEmail.toLowerCase()) {
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

      // 4. Update status in Firestore access_requests collection
      try {
        const reqDoc = doc(db, 'access_requests', effectiveReq.id);
        updateDoc(reqDoc, {
          status: 'approved',
          role: validatedRole,
          discipline: targetDiscipline,
          reviewedBy: `${SUPER_ADMIN_NAME} (Super Admin)`,
          reviewedAt: new Date().toISOString(),
        }).catch((err) => {
          console.warn('Firestore updateDoc access_requests error:', err);
        });
      } catch (e) {
        console.warn('Firestore doc access error:', e);
      }
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

    setOnboardingRequests((prev) =>
      prev.map((r) => {
        if (r.id === requestId) {
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

    if (rejectedReq) {
      const newAudit: AdminAuditLog = {
        id: `audit-${Date.now()}`,
        action: 'rejected',
        targetUserEmail: rejectedReq.email,
        targetUserName: rejectedReq.name,
        performedBy: `${SUPER_ADMIN_NAME} (Super Admin)`,
        timestamp: actionTimestamp,
        details: `Declined access request: ${notes || 'Access request declined by administrator.'}`,
      };
      setAuditLogs((prev) => [newAudit, ...prev]);

      // If user is registered in employees, suspend active status
      setEmployees((prev) =>
        prev.map((emp) =>
          emp.email.toLowerCase() === rejectedReq!.email.toLowerCase() ||
          emp.id === rejectedReq!.id ||
          (rejectedReq!.googleId && emp.id === rejectedReq!.googleId)
            ? { ...emp, status: 'Suspended' }
            : emp
        )
      );

      if (currentUser && currentUser.email.toLowerCase() === rejectedReq.email.toLowerCase()) {
        setCurrentUser((prev) => (prev ? { ...prev, status: 'REJECTED' } : null));
      }

      // Update status in Firestore access_requests collection
      try {
        const reqDoc = doc(db, 'access_requests', rejectedReq.id);
        updateDoc(reqDoc, {
          status: 'Rejected',
          reviewedBy: `${SUPER_ADMIN_NAME} (Super Admin)`,
          reviewedAt: new Date().toISOString(),
        }).catch((err) => {
          console.warn('Firestore updateDoc reject error:', err);
        });
        if (rejectedReq.googleId && rejectedReq.googleId !== rejectedReq.id) {
          const reqGoogleDoc = doc(db, 'access_requests', rejectedReq.googleId);
          updateDoc(reqGoogleDoc, {
            status: 'Rejected',
            reviewedBy: `${SUPER_ADMIN_NAME} (Super Admin)`,
            reviewedAt: new Date().toISOString(),
          }).catch(() => {});
        }
      } catch (e) {
        console.warn('Firestore doc access error:', e);
      }
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

    setOnboardingRequests((prev) =>
      prev.map((r) => {
        if (r.id === requestId) {
          reopenedReq = {
            ...r,
            status: 'PENDING',
            reviewedBy: undefined,
            reviewedAt: undefined,
            notes: 'Re-opened and restored to Pending Queue by Super Admin.',
          };
          return reopenedReq;
        }
        return r;
      })
    );

    if (reopenedReq) {
      const newAudit: AdminAuditLog = {
        id: `audit-${Date.now()}`,
        action: 'role_changed',
        targetUserEmail: reopenedReq.email,
        targetUserName: reopenedReq.name,
        performedBy: `${SUPER_ADMIN_NAME} (Super Admin)`,
        timestamp: actionTimestamp,
        details: `Re-opened declined access request for ${reopenedReq.name} (${reopenedReq.email}).`,
      };
      setAuditLogs((prev) => [newAudit, ...prev]);

      try {
        const reqDoc = doc(db, 'access_requests', reopenedReq.id);
        updateDoc(reqDoc, {
          status: 'Pending',
          reviewedBy: null,
          reviewedAt: null,
        }).catch(() => {});
        if (reopenedReq.googleId && reopenedReq.googleId !== reopenedReq.id) {
          const reqGoogleDoc = doc(db, 'access_requests', reopenedReq.googleId);
          updateDoc(reqGoogleDoc, {
            status: 'Pending',
            reviewedBy: null,
            reviewedAt: null,
          }).catch(() => {});
        }
      } catch (e) {
        console.warn('Firestore doc access error:', e);
      }
    }
  };

  const deleteOnboardingRequest = (requestId: string) => {
    const target = onboardingRequests.find((r) => r.id === requestId);
    if (!target) return;

    setOnboardingRequests((prev) => prev.filter((r) => r.id !== requestId));

    const newAudit: AdminAuditLog = {
      id: `audit-${Date.now()}`,
      action: 'user_deleted',
      targetUserEmail: target.email,
      targetUserName: target.name,
      performedBy: `${SUPER_ADMIN_NAME} (Super Admin)`,
      timestamp: new Date().toLocaleString([], {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }),
      details: `Removed access request record for ${target.email}`,
    };
    setAuditLogs((prev) => [newAudit, ...prev]);

    if (currentUser && currentUser.email.toLowerCase() === target.email.toLowerCase()) {
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
    // Sum hours from workLogs for this project
    const logged = workLogs
      .filter((w) => w.projectId === projectId)
      .reduce((sum, w) => sum + w.hoursLogged, 0);

    // Also include task completion if logged directly
    const project = getProjectById(projectId);
    const taskHours = project
      ? project.tasks.reduce((sum, t) => sum + t.completedHours, 0)
      : 0;

    const baseHours = project?.totalCompletedHours ?? 0;
    return Math.max(logged, taskHours, baseHours);
  };

  const getEmployeeLoggedHours = (
    employeeId: string,
    filterRange: string = 'this-week'
  ): number => {
    const today = new Date('2026-08-18');
    const logs = workLogs.filter((w) => {
      if (w.employeeId !== employeeId) return false;
      if (filterRange === 'all') return true;

      const logDate = new Date(w.date);
      if (filterRange === 'today') {
        return w.date === '2026-08-18';
      }
      if (filterRange === 'this-week') {
        const diffDays =
          Math.abs(today.getTime() - logDate.getTime()) / (1000 * 3600 * 24);
        return diffDays <= 7;
      }
      if (filterRange === 'this-month') {
        return (
          logDate.getMonth() === today.getMonth() &&
          logDate.getFullYear() === today.getFullYear()
        );
      }
      return true;
    });

    return logs.reduce((sum, l) => sum + l.hoursLogged, 0);
  };

  // Actions
  const addProject = (projectData: Omit<BimProject, 'id'>): BimProject => {
    const newProj: BimProject = {
      ...projectData,
      id: `proj-${Date.now()}`,
    };
    setProjects((prev) => [newProj, ...prev]);
    return newProj;
  };

  const updateProject = (id: string, updates: Partial<BimProject>) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...updates } : p))
    );
  };

  const updateProjectStatus = (id: string, status: BimProject['status']) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status } : p))
    );
  };

  const deleteProject = (id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id));
    setWorkLogs((prev) => prev.filter((w) => w.projectId !== id));
    if (selectedProjectId === id) {
      setSelectedProjectId('all');
    }
  };

  const addWorkLog = (
    logData: Omit<DailyWorkLog, 'id' | 'timestamp'>
  ): DailyWorkLog => {
    const newLog: DailyWorkLog = {
      ...logData,
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
    };
    setWorkLogs((prev) => [newLog, ...prev]);

    // Also update project task completed hours if applicable
    setProjects((prev) =>
      prev.map((proj) => {
        if (proj.id !== logData.projectId) return proj;
        const updatedTasks = proj.tasks.map((task) => {
          if (task.name === logData.taskName) {
            const newCompleted = task.completedHours + logData.hoursLogged;
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
        return { ...proj, tasks: updatedTasks };
      })
    );

    return newLog;
  };

  const updateWorkLog = (id: string, updates: Partial<DailyWorkLog>) => {
    setWorkLogs((prev) =>
      prev.map((w) => (w.id === id ? { ...w, ...updates } : w))
    );
  };

  const deleteWorkLog = (id: string) => {
    setWorkLogs((prev) => prev.filter((w) => w.id !== id));
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
    setEmployees((prev) => prev.filter((e) => e.id !== id));
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
    setEmployees(INITIAL_EMPLOYEES);
    setWorkLogs(generateInitialWorkLogs());
    setGeneratedReports([]);
    localStorage.removeItem(STORAGE_KEYS.PROJECTS);
    localStorage.removeItem(STORAGE_KEYS.EMPLOYEES);
    localStorage.removeItem(STORAGE_KEYS.WORK_LOGS);
    localStorage.removeItem(STORAGE_KEYS.REPORTS);
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
  }, [projects, employees, workLogs, selectedProjectId]);

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
