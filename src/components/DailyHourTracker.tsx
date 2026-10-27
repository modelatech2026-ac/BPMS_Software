import React, { useState, useEffect, useMemo } from 'react';
import {
  Clock,
  Calendar,
  Filter,
  Plus,
  Search,
  CheckCircle2,
  Trash2,
  Edit2,
  Download,
  Building,
  User,
  Tag,
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  FileSpreadsheet,
  X,
  Check,
  AlertTriangle,
} from 'lucide-react';
import {
  useBimData,
  getCurrentWeekRange,
  getEffectiveLogDate,
  toLocalIsoDate,
  isUserSuperAdmin,
  cleanProjectName,
} from '../context/BimDataContext';
import { db } from '../firebase/config';
import { collection, deleteDoc, doc, getDocs, onSnapshot } from 'firebase/firestore';
import { DailyWorkLog, Discipline, ActivityType, LODLevel, Employee } from '../types';

interface DailyHourTrackerProps {
  onOpenLogModal: () => void;
}

export const DailyHourTracker: React.FC<DailyHourTrackerProps> = ({
  onOpenLogModal,
}) => {
  const {
    workLogs,
    allWorkLogs,
    employees,
    projects,
    resourceAllocations,
    addWorkLog,
    updateWorkLog,
    deleteWorkLog,
    deleteEmployee,
    getEmployeeLoggedHours,
    currentUser,
  } = useBimData();

  const isDirector = useMemo(() => {
    if (!currentUser) return false;
    return (
      currentUser.securityRole === 'Director' ||
      currentUser.appRole === 'DIRECTOR' ||
      currentUser.accessLevel === 'Director' ||
      currentUser.role === 'Director'
    );
  }, [currentUser]);

  const isSuperAdmin = useMemo(() => isUserSuperAdmin(currentUser), [currentUser]);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedEmployeeFilter, setSelectedEmployeeFilter] = useState('all');
  const [selectedProjectFilter, setSelectedProjectFilter] = useState('all');
  const [selectedDisciplineFilter, setSelectedDisciplineFilter] = useState('all');
  const [startDateFilter, setStartDateFilter] = useState('');
  const [endDateFilter, setEndDateFilter] = useState('');
  const [logTypeFilter, setLogTypeFilter] = useState<'all' | 'operational' | 'test'>('all');
  const [activeView, setActiveView] = useState<'matrix' | 'logs'>('matrix');

  // Edit & Delete confirmation states
  const [logToDelete, setLogToDelete] = useState<DailyWorkLog | null>(null);
  const [deleteCandidateLogs, setDeleteCandidateLogs] = useState<DailyWorkLog[]>([]);
  const [matrixTargetMember, setMatrixTargetMember] = useState<{
    id: string;
    name: string;
    email?: string;
  } | null>(null);
  const [deletedMatrixEmpIds, setDeletedMatrixEmpIds] = useState<string[]>([]);
  const [editingLog, setEditingLog] = useState<DailyWorkLog | null>(null);
  const [editCandidateLogs, setEditCandidateLogs] = useState<DailyWorkLog[]>([]);
  const [modifiedMatrixEmpIds, setModifiedMatrixEmpIds] = useState<string[]>([]);
  const [matrixDeleteNotice, setMatrixDeleteNotice] = useState<string | null>(null);

  const showMatrixDeleteNotice = (message: string) => {
    setMatrixDeleteNotice(message);
    window.setTimeout(() => {
      setMatrixDeleteNotice((current) => (current === message ? null : current));
    }, 4000);
  };

  // Edit form fields
  const [editEmployeeId, setEditEmployeeId] = useState('');
  const [editProjectId, setEditProjectId] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editHours, setEditHours] = useState<number>(4);
  const [editLodStage, setEditLodStage] = useState<LODLevel>('LOD 350');
  const [editDiscipline, setEditDiscipline] = useState<Discipline>('BIM - ACS');
  const [editActivityType, setEditActivityType] = useState<ActivityType>('3D Detailed Modeling');
  const [editTaskName, setEditTaskName] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editBillable, setEditBillable] = useState<boolean>(true);
  const [editIsTestEntry, setEditIsTestEntry] = useState<boolean>(false);

  const openEditLogModal = (log: DailyWorkLog, candidates: DailyWorkLog[] = []) => {
    setEditingLog(log);
    setEditCandidateLogs(candidates);
    setEditEmployeeId(log.employeeId || '');
    setEditProjectId(log.projectId || projects[0]?.id || '');
    setEditDate(log.date || toLocalIsoDate(new Date()));
    setEditHours(Number(log.hoursLogged) || 0);
    setEditLodStage(log.lodStage || 'LOD 350');
    setEditDiscipline(log.discipline || 'BIM - ACS');
    setEditActivityType(log.activityType || '3D Detailed Modeling');
    setEditTaskName('');
    setEditNotes(log.notes || '');
    setEditBillable(log.billable !== undefined ? Boolean(log.billable) : true);
    setEditIsTestEntry(Boolean(log.isTestEntry));
  };

  const openMatrixRowEditModal = (
    emp: { id: string; name: string; email?: string; discipline?: Discipline },
    empLogs: DailyWorkLog[],
    preferredDate?: string
  ) => {
    const targetLog = preferredDate
      ? empLogs.find((w) => getEffectiveLogDate(w, currentWeekRange) === preferredDate) ||
        empLogs.find((w) => w.date === preferredDate)
      : empLogs[0];

    if (targetLog) {
      openEditLogModal(targetLog, empLogs);
      return;
    }

    const matchingAllocs = findMatchingAllocationsForMember(emp);
    const primaryAlloc = matchingAllocs[0];
    const defaultProj =
      (primaryAlloc && projects.find((p) => p.id === primaryAlloc.projectId)) ||
      projects[0];
    const draftDate = preferredDate || toLocalIsoDate(new Date());
    const draftLog: DailyWorkLog = {
      id: '__new_matrix_log__',
      employeeId: primaryAlloc?.memberId || primaryAlloc?.employeeId || emp.id,
      memberId: primaryAlloc?.memberId || primaryAlloc?.employeeId || emp.id,
      employeeName: primaryAlloc?.employeeName || emp.name,
      memberEmail: emp.email || primaryAlloc?.memberEmail || '',
      userEmail: emp.email || primaryAlloc?.memberEmail || '',
      projectId: primaryAlloc?.projectId || defaultProj?.id || '',
      projectName: primaryAlloc?.projectName || defaultProj?.name || 'BIM Project',
      date: draftDate,
      hoursLogged: 8,
      discipline: (primaryAlloc?.discipline as Discipline) || emp.discipline || 'BIM - ACS',
      activityType: '3D Detailed Modeling',
      taskName: primaryAlloc?.taskType || defaultProj?.tasks?.[0]?.name || 'BIM Modeling & Coordination',
      lodStage: (primaryAlloc?.lod as LODLevel) || defaultProj?.currentLOD || 'LOD 350',
      notes: 'Updated via Weekly Timesheet Matrix',
      billable: true,
      timestamp: new Date().toISOString(),
      isTestEntry: logTypeFilter === 'test',
    };
    openEditLogModal(draftLog, empLogs);
  };

  const findMatchingAllocationsForMember = (emp: { id: string; name?: string; email?: string }) => {
    const empId = (emp.id || '').trim();
    const empIdStripped = empId.replace(/^emp-/, '');
    const empEmail = (emp.email || '').toLowerCase().trim();
    const empName = (emp.name || '').toLowerCase().trim();

    return (resourceAllocations || []).filter((alloc) => {
      const raw = alloc as any;
      const aId = (alloc.employeeId || raw.memberId || raw.assignedTo || '').trim();
      const aIdStripped = aId.replace(/^emp-/, '');
      const aEmail = (alloc.memberEmail || raw.assignedToEmail || '').toLowerCase().trim();
      const aName = (alloc.employeeName || '').toLowerCase().trim();

      return (
        (empId && (aId === empId || (empIdStripped && aIdStripped === empIdStripped) || alloc.id === empId)) ||
        (empEmail && aEmail && aEmail === empEmail) ||
        (empName && aName && aName === empName)
      );
    });
  };

  const openMatrixRowDeleteModal = (
    emp: { id: string; name: string; email?: string; discipline?: Discipline },
    empWeekLogs: DailyWorkLog[],
    empAllLogs: DailyWorkLog[] = []
  ) => {
    setMatrixTargetMember(emp);
    const candidateLogs = empWeekLogs.length > 0 ? empWeekLogs : empAllLogs;
    if (candidateLogs.length > 0) {
      setDeleteCandidateLogs(candidateLogs);
      setLogToDelete(candidateLogs[0]);
      return;
    }

    const matchingAllocs = findMatchingAllocationsForMember(emp);
    const primaryAlloc = matchingAllocs[0];
    const fallbackRecord: DailyWorkLog = {
      id: primaryAlloc?.id || emp.id || '__fallback_allocation_delete__',
      employeeId: emp.id,
      employeeName: emp.name,
      memberEmail: emp.email || primaryAlloc?.memberEmail || '',
      userEmail: emp.email || primaryAlloc?.memberEmail || '',
      projectId: primaryAlloc?.projectId || projects[0]?.id || '',
      projectName: primaryAlloc?.projectName || 'Assigned Hours / Allocation',
      date: currentWeekRange.startIso,
      hoursLogged: primaryAlloc ? Number(primaryAlloc.assignedHours) || 0 : 0,
      discipline: (primaryAlloc?.discipline as Discipline) || emp.discipline || 'BIM - ACS',
      activityType: '3D Detailed Modeling',
      taskName: primaryAlloc?.taskType || 'Resource Allocation',
      lodStage: (primaryAlloc?.lod as LODLevel) || 'LOD 350',
      notes: 'Fallback allocation / matrix row deletion',
      billable: true,
      timestamp: new Date().toISOString(),
    };
    setDeleteCandidateLogs([]);
    setLogToDelete(fallbackRecord);
  };

  const handleSaveEditedLog = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLog) return;

    const matchedProj = projects.find((p) => p.id === editProjectId);
    const matchedEmp = allTrackedEmployees.find(
      (emp) =>
        emp.id === editEmployeeId ||
        emp.id.replace(/^emp-/, '') === editEmployeeId.replace(/^emp-/, '')
    );

    const rawTargetEmpId = matchedEmp?.id || editEmployeeId || editingLog.employeeId;
    const rawTargetProjId = matchedProj?.id || editProjectId || editingLog.projectId;

    const matchingAssignment = (resourceAllocations || []).find((alloc) => {
      const sameProj =
        alloc.projectId === rawTargetProjId ||
        alloc.projectId.replace(/^p(\d+)$/, 'proj-$1') === rawTargetProjId.replace(/^p(\d+)$/, 'proj-$1');
      if (!sameProj) return false;
      const aId = (alloc.memberId || alloc.employeeId || '').trim();
      const aIdStripped = aId.replace(/^emp-/, '');
      const tIdStripped = (rawTargetEmpId || '').replace(/^emp-/, '');
      const aEmail = (alloc.memberEmail || alloc.assignedToEmail || '').toLowerCase().trim();
      const tEmail = (matchedEmp?.email || editingLog.memberEmail || '').toLowerCase().trim();
      const aName = (alloc.employeeName || '').toLowerCase().trim();
      const tName = (matchedEmp?.name || editingLog.employeeName || '').toLowerCase().trim();
      return (
        (rawTargetEmpId && (aId === rawTargetEmpId || (aIdStripped && aIdStripped === tIdStripped))) ||
        (tEmail && aEmail && aEmail === tEmail) ||
        (tName && aName && aName === tName)
      );
    });

    const targetEmpId =
      matchingAssignment?.memberId ||
      matchingAssignment?.employeeId ||
      rawTargetEmpId;
    const targetProjectId = matchingAssignment?.projectId || rawTargetProjId;

    if (targetEmpId) {
      setModifiedMatrixEmpIds((prev) =>
        prev.includes(targetEmpId) ? prev : [...prev, targetEmpId]
      );
      setDeletedMatrixEmpIds((prev) => prev.filter((id) => id !== targetEmpId));
    }

    if (editingLog.id === '__new_matrix_log__') {
      addWorkLog({
        employeeId: targetEmpId,
        memberId: targetEmpId,
        employeeName: matchingAssignment?.employeeName || matchedEmp?.name || editingLog.employeeName,
        memberEmail: matchingAssignment?.memberEmail || matchedEmp?.email || editingLog.memberEmail,
        userEmail: matchingAssignment?.memberEmail || matchedEmp?.email || editingLog.userEmail,
        projectId: targetProjectId,
        projectName: matchingAssignment?.projectName || matchedProj?.name || editingLog.projectName,
        date: editDate,
        hoursLogged: Number(editHours) || 0,
        lodStage: editLodStage,
        discipline: editDiscipline,
        activityType: editActivityType,
        taskName: editTaskName || '',
        notes: editNotes,
        billable: Boolean(editBillable),
        isTestEntry: Boolean(editIsTestEntry),
      });
    } else {
      updateWorkLog(editingLog.id, {
        employeeId: targetEmpId,
        memberId: targetEmpId,
        employeeName: matchingAssignment?.employeeName || matchedEmp?.name || editingLog.employeeName,
        memberEmail: matchingAssignment?.memberEmail || matchedEmp?.email || editingLog.memberEmail,
        userEmail: matchingAssignment?.memberEmail || matchedEmp?.email || editingLog.userEmail,
        projectId: targetProjectId,
        projectName: matchingAssignment?.projectName || matchedProj?.name || editingLog.projectName,
        date: editDate,
        hoursLogged: Number(editHours) || 0,
        lodStage: editLodStage,
        discipline: editDiscipline,
        activityType: editActivityType,
        taskName: editTaskName || '',
        notes: editNotes,
        billable: Boolean(editBillable),
        isTestEntry: Boolean(editIsTestEntry),
      });
    }

    setEditingLog(null);
    setEditCandidateLogs([]);
  };

  const deleteFallbackAllocationsForMember = async (
    targetEmp: { id: string; name?: string; email?: string },
    fallbackDocId?: string
  ) => {
    const empId = (targetEmp.id || '').trim();
    const empIdStripped = empId.replace(/^emp-/, '');
    const empEmail = (targetEmp.email || '').toLowerCase().trim();
    const empName = (targetEmp.name || '').toLowerCase().trim();

    const matchingAllocs = findMatchingAllocationsForMember(targetEmp);
    const docIdsToDelete = new Set<string>();
    if (fallbackDocId && fallbackDocId !== '__fallback_allocation_delete__') {
      docIdsToDelete.add(fallbackDocId);
    }
    if (empId) docIdsToDelete.add(empId);
    if (empIdStripped) docIdsToDelete.add(empIdStripped);
    matchingAllocs.forEach((a) => {
      if (a.id) docIdsToDelete.add(a.id);
    });

    // Update local allocations cache & notify listeners immediately
    try {
      const saved = localStorage.getItem('bim_resource_allocations_v2');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const remaining = parsed.filter((alloc: any) => {
            const aId = (alloc.employeeId || alloc.memberId || alloc.assignedTo || '').trim();
            const aIdStripped = aId.replace(/^emp-/, '');
            const aEmail = (alloc.memberEmail || alloc.assignedToEmail || '').toLowerCase().trim();
            const aName = (alloc.employeeName || '').toLowerCase().trim();
            const isMatch =
              docIdsToDelete.has(alloc.id) ||
              (empId && (aId === empId || (empIdStripped && aIdStripped === empIdStripped))) ||
              (empEmail && aEmail && aEmail === empEmail) ||
              (empName && aName && aName === empName);
            return !isMatch;
          });
          localStorage.setItem('bim_resource_allocations_v2', JSON.stringify(remaining));
          window.dispatchEvent(new CustomEvent('bim_resource_allocations_updated', { detail: remaining }));
        }
      }
    } catch {}

    // Delete matching documents directly from Firestore assigned_hours, allocations, and project_assignments
    for (const docId of Array.from(docIdsToDelete)) {
      try {
        await deleteDoc(doc(db, 'assigned_hours', docId));
      } catch {}
      try {
        await deleteDoc(doc(db, 'allocations', docId));
      } catch {}
      try {
        await deleteDoc(doc(db, 'project_assignments', docId));
      } catch {}
    }

    // Also scan assigned_hours and allocations collections for any documents referencing this member
    for (const colName of ['assigned_hours', 'allocations', 'project_assignments']) {
      try {
        const snap = await getDocs(collection(db, colName));
        for (const d of snap.docs) {
          const data = d.data() || {};
          const dEmpId = String(data.employeeId || data.memberId || data.assignedTo || '').trim();
          const dEmpIdStripped = dEmpId.replace(/^emp-/, '');
          const dEmail = String(data.memberEmail || data.assignedToEmail || data.email || '').toLowerCase().trim();
          const dName = String(data.employeeName || data.name || '').toLowerCase().trim();
          if (
            (empId && (dEmpId === empId || (empIdStripped && dEmpIdStripped === empIdStripped))) ||
            (empEmail && dEmail && dEmail === empEmail) ||
            (empName && dName && dName === empName)
          ) {
            await deleteDoc(doc(db, colName, d.id)).catch(() => {});
          }
        }
      } catch {}
    }
  };

  const handleConfirmDeleteLog = async () => {
    if (!logToDelete) {
      setLogToDelete(null);
      setDeleteCandidateLogs([]);
      setMatrixTargetMember(null);
      return;
    }

    const matchedEmp =
      matrixTargetMember ||
      allTrackedEmployees.find((emp) => doesLogMatchEmployee(logToDelete, emp)) || {
        id: logToDelete.employeeId || '',
        name: logToDelete.employeeName || '',
        email: logToDelete.memberEmail || logToDelete.userEmail || '',
      };

    if (logToDelete.employeeId) {
      const empId = logToDelete.employeeId;
      setModifiedMatrixEmpIds((prev) => (prev.includes(empId) ? prev : [...prev, empId]));
    }
    if (matchedEmp?.id) {
      setModifiedMatrixEmpIds((prev) =>
        prev.includes(matchedEmp.id) ? prev : [...prev, matchedEmp.id]
      );
    }

    const hasActualDailyLogs =
      deleteCandidateLogs.length > 0 &&
      logToDelete.id !== '__fallback_allocation_delete__' &&
      workLogs.some((w) => w.id === logToDelete.id);

    if (hasActualDailyLogs) {
      deleteWorkLog(logToDelete.id);
    } else {
      // Fallback: no matching daily_logs found -> delete from assigned_hours / allocations
      await deleteFallbackAllocationsForMember(matchedEmp, logToDelete.id);
      if (matchedEmp?.id) {
        setDeletedMatrixEmpIds((prev) =>
          prev.includes(matchedEmp.id) ? prev : [...prev, matchedEmp.id]
        );
        deleteEmployee(matchedEmp.id);
      }
    }

    setLogToDelete(null);
    setDeleteCandidateLogs([]);
    setMatrixTargetMember(null);
    showMatrixDeleteNotice('Record successfully deleted');
  };

  // Helper to match a work log to an employee record across all identifiers
  const doesLogMatchEmployee = (log: DailyWorkLog, emp: { id: string; name?: string; email?: string }): boolean => {
    const empId = (emp.id || '').trim();
    const empIdStripped = empId.replace(/^emp-/, '');
    const logEmpId = (log.employeeId || '').trim();
    const logEmpIdStripped = logEmpId.replace(/^emp-/, '');
    const logUserId = ((log as any).userId || '').trim();
    const logUserIdStripped = logUserId.replace(/^emp-/, '');

    if (
      empId &&
      (logEmpId === empId ||
        (empIdStripped && logEmpIdStripped === empIdStripped) ||
        logUserId === empId ||
        (empIdStripped && logUserIdStripped === empIdStripped))
    ) {
      return true;
    }

    const empEmail = (emp.email || '').toLowerCase().trim();
    const logEmail = ((log as any).memberEmail || (log as any).userEmail || '').toLowerCase().trim();
    if (empEmail && logEmail && empEmail === logEmail) {
      return true;
    }

    const empName = (emp.name || '').toLowerCase().trim();
    const logName = (log.employeeName || '').toLowerCase().trim();
    if (empName && logName && empName === logName) {
      return true;
    }

    return false;
  };

  // Dynamic current week range (Monday - Sunday) based on new Date()
  const currentWeekRange = useMemo(() => getCurrentWeekRange(new Date()), []);
  const weekDays = useMemo(() => currentWeekRange.days, [currentWeekRange]);

  // Real-time onSnapshot listener on Firestore 'users' collection for instant matrix synchronization
  const [firestoreUsers, setFirestoreUsers] = useState<Employee[]>([]);
  useEffect(() => {
    let unsub: (() => void) | undefined;
    try {
      unsub = onSnapshot(
        collection(db, 'users'),
        (snapshot) => {
          const usersList: Employee[] = [];
          snapshot.docs.forEach((docSnap) => {
            const data = docSnap.data() || {};
            if (data.isDeleted === true || String(data.status || '').toLowerCase() === 'deleted') {
              return;
            }
            const email = String(data.email || data.userEmail || '').trim().toLowerCase();
            if (email === 'sushovan.das@bimworkspace.com' || email === 'aditi@bimworkspace.com') {
              return;
            }
            const isSuper = email === 'modelatech2026@gmail.com';
            const name = isSuper
              ? 'Aditi Chakraborty'
              : String(data.fullName || data.name || (email ? email.split('@')[0] : '')).trim();
            if (!name && !email) return;
            const disc = ((data.discipline || data.primaryDiscipline || 'BIM - ACS') as Discipline);
            usersList.push({
              id: isSuper
                ? 'emp-modelatech2026_gmail_com'
                : String(data.id || (docSnap.id.startsWith('emp-') ? docSnap.id : `emp-${docSnap.id}`)).trim(),
              name,
              email: isSuper ? 'modelatech2026@gmail.com' : email,
              role: (isSuper ? 'Super Admin' : data.role || data.assignedRole || 'BIM Modeler') as any,
              primaryDiscipline: disc,
              discipline: disc,
              avatar:
                data.avatar ||
                `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name)}`,
              weeklyCapacityHours: Number(data.weeklyCapacityHours) || 40,
              experienceYears: Number(data.experienceYears) || 4,
              status: 'Active',
              activeProjectIds: Array.isArray(data.activeProjectIds) ? data.activeProjectIds : [],
              skills: [disc],
              phone: data.phone || '',
            });
          });
          setFirestoreUsers(usersList);
        },
        (err) => {
          console.warn('DailyHourTracker users listener notice:', err);
        }
      );
    } catch (e) {
      console.warn('DailyHourTracker users setup notice:', e);
    }
    return () => {
      if (unsub) unsub();
    };
  }, []);

  // Active team members across the organization (including Super Admin Aditi Chakraborty)
  const allTrackedEmployees = useMemo(() => {
    let deletedSet = new Set<string>();
    try {
      const saved = localStorage.getItem('bim_deleted_members_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          deletedSet = new Set(parsed.map((v: string) => String(v).trim().toLowerCase()));
        }
      }
    } catch {}

    const superAdminMember: Employee = {
      id: 'emp-modelatech2026_gmail_com',
      name: 'Aditi Chakraborty',
      email: 'modelatech2026@gmail.com',
      avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Aditi%20Chakraborty',
      role: 'Super Admin' as any,
      primaryDiscipline: 'BIM - ACS',
      discipline: 'BIM - ACS',
      weeklyCapacityHours: 40,
      experienceYears: 8,
      status: 'Active',
      activeProjectIds: [],
      skills: ['BIM - ACS'],
      phone: '',
    };

    const baseMembers = (employees || []).filter(
      (member) => !member.isDeleted && member.status !== 'deleted'
    );

    const list: Employee[] = [];
    const knownKeys = new Set<string>();

    const registerMember = (emp: Employee) => {
      if (!emp || emp.isDeleted || emp.status === 'deleted') return;
      const emailKey = (emp.email || '').toLowerCase().trim();
      const nameKey = (emp.name || '').toLowerCase().trim();
      const idKey = (emp.id || '').trim();
      const idKeyLower = idKey.toLowerCase();
      const strippedIdKey = idKey.replace(/^emp-/, '');
      const strippedIdLower = strippedIdKey.toLowerCase();

      if (emailKey !== 'modelatech2026@gmail.com') {
        const isDeletedMember =
          deletedMatrixEmpIds.includes(emp.id) ||
          (idKeyLower && deletedSet.has(idKeyLower)) ||
          (strippedIdLower && deletedSet.has(strippedIdLower)) ||
          (nameKey && deletedSet.has(nameKey)) ||
          (nameKey && deletedSet.has(`name:${nameKey}`)) ||
          (emailKey && deletedSet.has(emailKey));
        if (isDeletedMember) return;
      }

      const alreadyExists =
        (idKey && knownKeys.has(idKey)) ||
        (strippedIdKey && knownKeys.has(strippedIdKey)) ||
        (nameKey && knownKeys.has(nameKey)) ||
        (emailKey && knownKeys.has(emailKey));

      if (!alreadyExists && (nameKey || idKey || emailKey)) {
        if (idKey) knownKeys.add(idKey);
        if (strippedIdKey) knownKeys.add(strippedIdKey);
        if (nameKey) knownKeys.add(nameKey);
        if (emailKey) knownKeys.add(emailKey);
        list.push(emp);
      }
    };

    // 1. Always include active team members from context & Firestore users collection & Super Admin
    baseMembers.forEach(registerMember);
    firestoreUsers.forEach(registerMember);
    registerMember(superAdminMember);

    // 2. Include current authenticated user if not already in the list
    if (currentUser) {
      const userEmail = (currentUser.email || '').toLowerCase().trim();
      const userId = (currentUser.id || '').trim();
      registerMember({
        id: userId || 'emp-user',
        name: currentUser.name || (userEmail ? userEmail.split('@')[0] : 'Team Member'),
        email: currentUser.email || '',
        avatar:
          currentUser.avatar ||
          `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(
            currentUser.name || 'User'
          )}`,
        role: (currentUser.role || 'BIM Modeler') as any,
        primaryDiscipline: 'BIM - ACS',
        discipline: 'BIM - ACS',
        weeklyCapacityHours: 40,
        experienceYears: 3,
        status: 'Active',
        activeProjectIds: [],
        skills: ['BIM - ACS'],
        phone: '',
      });
    }

    // 3. Also include any active members referenced in resourceAllocations or workLogs
    (resourceAllocations || []).forEach((alloc) => {
      const name = (alloc.assignedToName || alloc.employeeName || alloc.memberName || '').trim();
      const email = (alloc.assignedToEmail || alloc.memberEmail || '').toLowerCase().trim();
      const id = (alloc.assignedTo || alloc.employeeId || alloc.memberId || '').trim();
      if (!name && !email && !id) return;
      registerMember({
        id: id || `emp-${Date.now()}`,
        name: name || (email ? email.split('@')[0] : 'Team Member'),
        email,
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(
          name || email || 'User'
        )}`,
        role: (alloc.employeeRole || 'BIM Modeler') as any,
        primaryDiscipline: (alloc.discipline || 'BIM - ACS') as Discipline,
        discipline: (alloc.discipline || 'BIM - ACS') as Discipline,
        weeklyCapacityHours: 40,
        experienceYears: 3,
        status: 'Active',
        activeProjectIds: [alloc.projectId].filter(Boolean),
        skills: [(alloc.discipline || 'BIM - ACS') as Discipline],
        phone: '',
      });
    });

    (allWorkLogs || workLogs || []).forEach((log) => {
      const name = (log.employeeName || '').trim();
      const email = ((log as any).memberEmail || (log as any).userEmail || '').toLowerCase().trim();
      const id = (log.employeeId || (log as any).userId || '').trim();
      if (!name && !email && !id) return;
      registerMember({
        id: id || `emp-${Date.now()}`,
        name: name || (email ? email.split('@')[0] : 'Team Member'),
        email,
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(
          name || email || 'User'
        )}`,
        role: 'BIM Modeler' as any,
        primaryDiscipline: log.discipline || 'BIM - ACS',
        discipline: log.discipline || 'BIM - ACS',
        weeklyCapacityHours: 40,
        experienceYears: 3,
        status: 'Active',
        activeProjectIds: [log.projectId].filter(Boolean),
        skills: [log.discipline || 'BIM - ACS'],
        phone: '',
      });
    });

    return list;
  }, [
    employees,
    firestoreUsers,
    allWorkLogs,
    workLogs,
    resourceAllocations,
    currentUser,
    deletedMatrixEmpIds,
  ]);

  // Full Member Matrix Outer Join: maps directly from the complete list of active team members,
  // performing an outer join with daily_logs for the selected week range so 0.0h members are always rendered.
  const fullWeeklyMatrix = useMemo(() => {
    const sourceLogs = allWorkLogs && allWorkLogs.length > 0 ? allWorkLogs : workLogs || [];
    const weeklyLogs = sourceLogs.filter((w) => {
      const matchesType =
        logTypeFilter === 'test'
          ? Boolean(w.isTestEntry)
          : logTypeFilter === 'operational'
          ? !w.isTestEntry
          : true;
      if (!matchesType) return false;
      const effDate = getEffectiveLogDate(w, currentWeekRange);
      return effDate >= currentWeekRange.startIso && effDate <= currentWeekRange.endIso;
    });

    const computeWeeklyTotals = (userLogs: DailyWorkLog[], user: Employee) => {
      let weekSum = 0;
      const dailyHours = weekDays.map((d) => {
        const dayLogs = sourceLogs.filter(
          (w) =>
            (logTypeFilter === 'test' ? Boolean(w.isTestEntry) : !w.isTestEntry) &&
            (w.employeeId === user.id || doesLogMatchEmployee(w, user)) &&
            getEffectiveLogDate(w, currentWeekRange) === d.date
        );
        const hours = dayLogs.reduce((sum, l) => sum + (Number(l.hoursLogged) || 0), 0);
        weekSum += hours;
        return { date: d.date, hours, dayLogs };
      });
      return { weekSum, dailyHours, userLogs };
    };

    return allTrackedEmployees.map((user) => {
      const empAllLogs = sourceLogs.filter(
        (w) =>
          (logTypeFilter === 'test'
            ? Boolean(w.isTestEntry)
            : logTypeFilter === 'operational'
            ? !w.isTestEntry
            : true) &&
          (w.employeeId === user.id || doesLogMatchEmployee(w, user))
      );
      const userLogs = weeklyLogs.filter(
        (log) => log.employeeId === user.id || doesLogMatchEmployee(log, user)
      );
      const empActionLogs = userLogs.length > 0 ? userLogs : empAllLogs;

      return {
        user,
        empAllLogs,
        empWeekLogs: userLogs,
        empActionLogs,
        weeklyTotals: computeWeeklyTotals(userLogs, user),
      };
    });
  }, [allTrackedEmployees, allWorkLogs, workLogs, logTypeFilter, currentWeekRange, weekDays]);

  useEffect(() => {
    if (
      selectedEmployeeFilter !== 'all' &&
      !allTrackedEmployees.some((e) => e.id === selectedEmployeeFilter)
    ) {
      setSelectedEmployeeFilter('all');
    }
  }, [allTrackedEmployees, selectedEmployeeFilter]);

  // Base filtered logs (by role/ownership, search, project, employee, discipline) before logTypeFilter
  const baseFilteredLogs = useMemo(() => {
    return (workLogs || []).filter((log) => {
      const selectedEmpObj = allTrackedEmployees.find((e) => e.id === selectedEmployeeFilter);

      if (!isSuperAdmin) {
        const userEmail = (currentUser?.email || '').trim().toLowerCase();
        const userId = (currentUser?.id || '').trim();
        const userIdStripped = userId.replace(/^emp-/, '');
        const logEmpId = (log.employeeId || '').trim();
        const logUserId = ((log as any).userId || '').trim();
        const isOwned =
          (userEmail && ((log.memberEmail || (log as any).userEmail || '').trim().toLowerCase() === userEmail)) ||
          (userId && (logUserId === userId || logEmpId === userId || logUserId.replace(/^emp-/, '') === userIdStripped || logEmpId.replace(/^emp-/, '') === userIdStripped)) ||
          (currentUser?.name && (log.employeeName || '').toLowerCase().trim() === currentUser.name.toLowerCase().trim()) ||
          (selectedEmpObj && doesLogMatchEmployee(log, selectedEmpObj));
        if (!isOwned) return false;
      }

      const matchesSearch =
        (log.notes || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (log.taskName || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (log.employeeName || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (log.projectName || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (log.discipline || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (log.activityType || '').toLowerCase().includes(searchQuery.toLowerCase());

      const matchesEmp =
        !isSuperAdmin ||
        selectedEmployeeFilter === 'all' ||
        log.employeeId === selectedEmployeeFilter ||
        (selectedEmpObj ? doesLogMatchEmployee(log, selectedEmpObj) : false);

      const matchesProj =
        selectedProjectFilter === 'all' || log.projectId === selectedProjectFilter;
      const matchesDisc =
        selectedDisciplineFilter === 'all' || log.discipline === selectedDisciplineFilter;
      const logDateIso = (log.date || '').slice(0, 10);
      const matchesStartDate =
        !startDateFilter || (Boolean(logDateIso) && logDateIso >= startDateFilter);
      const matchesEndDate =
        !endDateFilter || (Boolean(logDateIso) && logDateIso <= endDateFilter);

      return (
        matchesSearch &&
        matchesEmp &&
        matchesProj &&
        matchesDisc &&
        matchesStartDate &&
        matchesEndDate
      );
    });
  }, [
    workLogs,
    allTrackedEmployees,
    selectedEmployeeFilter,
    isSuperAdmin,
    currentUser,
    searchQuery,
    selectedProjectFilter,
    selectedDisciplineFilter,
    startDateFilter,
    endDateFilter,
  ]);

  const operationalCount = useMemo(
    () => baseFilteredLogs.filter((l) => !l.isTestEntry).length,
    [baseFilteredLogs]
  );
  const testCount = useMemo(
    () => baseFilteredLogs.filter((l) => Boolean(l.isTestEntry)).length,
    [baseFilteredLogs]
  );

  // Filtered log list applying All Logs / Operational Only / Test Logs Only filter
  const filteredLogs = useMemo(() => {
    if (logTypeFilter === 'operational') {
      return baseFilteredLogs.filter((l) => !l.isTestEntry);
    }
    if (logTypeFilter === 'test') {
      return baseFilteredLogs.filter((l) => Boolean(l.isTestEntry));
    }
    return baseFilteredLogs;
  }, [baseFilteredLogs, logTypeFilter]);

  // Keep normal logged-hour calculations unchanged:
  // Test entries must not affect operational totals unless explicitly intended by the selected filter ('test').
  const operationalFilteredHours = useMemo(
    () =>
      baseFilteredLogs
        .filter((l) => !l.isTestEntry)
        .reduce((sum, l) => sum + (Number(l.hoursLogged) || 0), 0),
    [baseFilteredLogs]
  );

  const testFilteredHours = useMemo(
    () =>
      baseFilteredLogs
        .filter((l) => Boolean(l.isTestEntry))
        .reduce((sum, l) => sum + (Number(l.hoursLogged) || 0), 0),
    [baseFilteredLogs]
  );

  const totalFilteredHours =
    logTypeFilter === 'test' ? testFilteredHours : operationalFilteredHours;

  // Export to CSV function
  const exportLogsToCsv = () => {
    const headers = ['Date', 'Employee', 'Project', 'Discipline', 'Activity', 'Task', 'LOD', 'Hours', 'Billable', 'Entry Type', 'Notes'];
    const rows = filteredLogs.map((l) => [
      l.date,
      `"${l.employeeName || ''}"`,
      `"${l.projectName || ''}"`,
      `"${l.discipline || ''}"`,
      `"${l.activityType || ''}"`,
      `"${l.taskName || ''}"`,
      l.lodStage,
      l.hoursLogged,
      l.billable ? 'Yes' : 'No',
      l.isTestEntry ? 'TEST' : 'Operational',
      `"${(l.notes || '').replace(/"/g, '""')}"`,
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `BIM_Timesheet_Logs_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const canModifyLog = (_log: DailyWorkLog): boolean => {
    return isSuperAdmin;
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Toast Notification for Matrix / Log Deletion */}
      {matrixDeleteNotice && (
        <div
          role="status"
          className="fixed top-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-slate-900 border border-emerald-500/40 text-emerald-300 shadow-2xl text-xs font-semibold animate-in fade-in slide-in-from-top-2"
        >
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{matrixDeleteNotice}</span>
          <button
            type="button"
            onClick={() => setMatrixDeleteNotice(null)}
            className="ml-2 p-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition"
            aria-label="Dismiss notification"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-white tracking-tight">
              Daily Hour Tracking
            </h2>
            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30">
              Organizational Timesheets
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Tracking daily modeler work hours, multi-project tasks, and weekly employee capacity utilization
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportLogsToCsv}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
            title="Export CSV"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
          <button
            onClick={onOpenLogModal}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition shadow-sm"
          >
            <Plus className="w-4 h-4" />
            <span>Log Daily Hours</span>
          </button>
        </div>
      </div>

      {/* View Switcher & Quick Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-slate-100 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400 font-semibold uppercase">
                {logTypeFilter === 'test' ? 'Total Logged (Test Only)' : 'Total Logged (Operational)'}
              </span>
              {totalFilteredHours > 0 && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  Daily Hours Logged
                </span>
              )}
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <p className="text-2xl font-bold text-white">{totalFilteredHours.toFixed(1)} hrs</p>
              <span className="text-[11px] font-mono font-semibold text-emerald-400">
                (Hours Logged: {totalFilteredHours.toFixed(1)}h)
              </span>
              {logTypeFilter === 'all' && testFilteredHours > 0 && (
                <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  +{testFilteredHours.toFixed(1)}h [TEST] excluded
                </span>
              )}
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-blue-500/10 text-blue-400 flex items-center justify-center">
            <Clock className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-slate-100 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400 font-semibold uppercase">Logged Entries</span>
              {filteredLogs.length > 0 && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  Daily Hours Logged
                </span>
              )}
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <p className="text-2xl font-bold text-white">{filteredLogs.length} Records</p>
              {testCount > 0 && logTypeFilter === 'all' && (
                <span className="text-[11px] font-semibold text-amber-300">
                  ({testCount} Test)
                </span>
              )}
            </div>
          </div>
          <div className="w-10 h-10 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-slate-100 flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-400 font-semibold uppercase">
              {isSuperAdmin ? 'Active Engaged Staff' : 'Active Modeler'}
            </span>
            <p className="text-2xl font-bold text-white mt-1">
              {isSuperAdmin ? `${allTrackedEmployees.length} Specialists` : (currentUser?.name || 'My Record')}
            </p>
          </div>
          <div className="w-10 h-10 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center">
            <User className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Tabs for Matrix vs Log Stream + Log Entry Type Filter (All Logs / Operational Only / Test Logs Only) */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveView('matrix')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
              activeView === 'matrix'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            Weekly Timesheet Matrix
          </button>
          <button
            onClick={() => setActiveView('logs')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
              activeView === 'logs'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            Detailed Log Records ({filteredLogs.length})
          </button>
        </div>

        {/* Entry Type Filter Buttons (Detailed Log Records only) */}
        {activeView === 'logs' && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => setLogTypeFilter('all')}
                className={`px-3 py-1 rounded-md font-semibold transition ${
                  logTypeFilter === 'all'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                All Logs ({baseFilteredLogs.length})
              </button>
              <button
                type="button"
                onClick={() => setLogTypeFilter('operational')}
                className={`px-3 py-1 rounded-md font-semibold transition ${
                  logTypeFilter === 'operational'
                    ? 'bg-emerald-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Operational Only ({operationalCount})
              </button>
              <button
                type="button"
                onClick={() => setLogTypeFilter('test')}
                className={`px-3 py-1 rounded-md font-semibold transition flex items-center gap-1 ${
                  logTypeFilter === 'test'
                    ? 'bg-amber-500 text-slate-950 font-bold shadow-xs'
                    : 'text-amber-300/80 hover:text-amber-300'
                }`}
              >
                <span>Test Logs Only ({testCount})</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Matrix View: Employee rows across days of the week */}
      {activeView === 'matrix' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between text-xs text-slate-300 bg-slate-800/40">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-white">
                {isSuperAdmin
                  ? `Weekly Team Timesheet Matrix (${currentWeekRange.label})`
                  : `My Weekly Timesheet Matrix (${currentWeekRange.label})`}
              </span>
              {logTypeFilter === 'test' && (
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  [TEST] FILTER ACTIVE
                </span>
              )}
            </div>
            <span className="text-slate-400">Standard Target: 40.0 hrs / week</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-800/80 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-700">
                <tr>
                  <th className="p-3.5 min-w-[200px]">Employee & Role</th>
                  {weekDays.map((d) => (
                    <th key={d.date} className="p-3.5 text-center min-w-[80px]">
                      <div>{d.label}</div>
                      <div className="text-[10px] text-slate-500">{d.dayNum}</div>
                    </th>
                  ))}
                  <th className="p-3.5 text-right font-bold min-w-[100px]">Weekly Total</th>
                  <th className="p-3.5 text-center min-w-[100px]">Capacity</th>
                  {isSuperAdmin && (
                    <th className="p-3.5 text-right min-w-[90px]">Action</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {fullWeeklyMatrix.map(({ user: emp, empAllLogs, empWeekLogs, empActionLogs, weeklyTotals }) => {
                  const { weekSum, dailyHours } = weeklyTotals;

                  const effectiveWeeklyLoad =
                    logTypeFilter === 'test'
                      ? weekSum
                      : weekSum > 0 || modifiedMatrixEmpIds.includes(emp.id)
                      ? weekSum
                      : getEmployeeLoggedHours(emp.id, 'this-week');
                  const capHours = emp.weeklyCapacityHours || 40;
                  const capPct = Math.round((effectiveWeeklyLoad / capHours) * 100);
                  const isOver = effectiveWeeklyLoad > capHours;

                  return (
                    <tr key={emp.id} className="hover:bg-slate-800/40 transition">
                      <td className="p-3.5">
                        <div>
                          <div className="font-bold text-white">{emp.name}</div>
                          <div className="text-[11px] text-slate-400">{emp.role}</div>
                        </div>
                      </td>

                      {dailyHours.map((d) => (
                        <td key={d.date} className="p-3.5 text-center">
                          {d.hours > 0 ? (
                            <span
                              onClick={
                                isSuperAdmin
                                  ? () => openMatrixRowEditModal(emp, empActionLogs, d.date)
                                  : undefined
                              }
                              title={
                                isSuperAdmin
                                  ? `Click to edit ${emp.name}'s hours for ${d.date}`
                                  : undefined
                              }
                              className={`inline-block px-2 py-0.5 rounded font-semibold text-xs ${
                                isSuperAdmin ? 'cursor-pointer hover:ring-1 hover:ring-blue-400/60 transition' : ''
                              } ${
                                logTypeFilter === 'test'
                                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                  : d.hours >= 8
                                  ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                                  : 'bg-slate-800 text-slate-300'
                              }`}
                            >
                              {d.hours.toFixed(1)}h
                            </span>
                          ) : (
                            <span
                              onClick={
                                isSuperAdmin
                                  ? () => openMatrixRowEditModal(emp, empActionLogs, d.date)
                                  : undefined
                              }
                              title={
                                isSuperAdmin
                                  ? `Click to log/edit hours for ${emp.name} on ${d.date}`
                                  : undefined
                              }
                              className={`text-slate-600 font-mono ${
                                isSuperAdmin ? 'cursor-pointer hover:text-slate-400 transition' : ''
                              }`}
                            >
                              -
                            </span>
                          )}
                        </td>
                      ))}

                      <td className="p-3.5 text-right font-bold text-sm text-white">
                        <div className="flex flex-col items-end gap-0.5">
                          <span>Hours Logged: {weekSum.toFixed(1)}h</span>
                          {weekSum > 0 && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 whitespace-nowrap">
                              Daily Hours Logged
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="p-3.5 text-center">
                        <span
                          className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                            isOver
                              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                              : capPct >= 80
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          {capPct}% {isOver && '⚡'}
                        </span>
                      </td>

                      {isSuperAdmin && (
                        <td className="p-3.5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => openMatrixRowEditModal(emp, empActionLogs)}
                              className="p-1.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 hover:text-blue-300 border border-blue-500/20 hover:border-blue-500/40 transition"
                              title="Edit logged hours for a specific day or project"
                              aria-label={`Edit matrix hours for ${emp.name}`}
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => openMatrixRowDeleteModal(emp, empWeekLogs, empAllLogs)}
                              className="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 border border-rose-500/20 hover:border-rose-500/40 transition"
                              title="Delete this daily log entry?"
                              aria-label={`Delete daily log entry for ${emp.name}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Detailed Log Stream */}
      {activeView === 'logs' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 bg-slate-900 border border-slate-800 p-4 rounded-xl text-xs">
            <div>
              <label className="block text-slate-400 font-medium mb-1">Search Keywords</label>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Task, notes, names..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-slate-800 text-slate-200 rounded-lg pl-8 pr-2.5 py-1.5 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-slate-400 font-medium mb-1">Filter by Project</label>
              <select
                value={selectedProjectFilter}
                onChange={(e) => setSelectedProjectFilter(e.target.value)}
                className="w-full bg-slate-800 text-slate-200 rounded-lg px-2.5 py-1.5 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
              >
                <option value="all">All Projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {cleanProjectName(p.name)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-slate-400 font-medium mb-1">
                {isSuperAdmin ? 'Filter by Employee' : 'Member Timesheet'}
              </label>
              {isSuperAdmin ? (
                <select
                  value={selectedEmployeeFilter}
                  onChange={(e) => setSelectedEmployeeFilter(e.target.value)}
                  className="w-full bg-slate-800 text-slate-200 rounded-lg px-2.5 py-1.5 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
                >
                  <option value="all">All Employees ({allTrackedEmployees.length})</option>
                  {allTrackedEmployees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} {e.role ? `(${e.role})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="w-full bg-slate-800/80 text-blue-300 font-semibold rounded-lg px-2.5 py-1.5 border border-slate-700/80 text-xs truncate">
                  {currentUser?.name || currentUser?.email || 'My Log Records'}
                </div>
              )}
            </div>

            <div>
              <label className="block text-slate-400 font-medium mb-1">Filter by Discipline</label>
              <select
                value={selectedDisciplineFilter}
                onChange={(e) => setSelectedDisciplineFilter(e.target.value)}
                className="w-full bg-slate-800 text-slate-200 rounded-lg px-2.5 py-1.5 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
              >
                <option value="all">All Disciplines</option>
                <option value="BIM - ACS">BIM - ACS</option>
                <option value="Structure">Structure</option>
                <option value="MEP - HVAC">MEP - HVAC</option>
                <option value="MEP - Electrical">MEP - Electrical</option>
                <option value="MEP - Plumbing">MEP - Plumbing</option>
                <option value="Fire Protection">Fire Protection</option>
                <option value="Façade / Envelope">Façade / Envelope</option>
                <option value="Coordination & QA">Coordination & QA</option>
                <option value="AI & Automation">AI & Automation</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-400 font-medium mb-1">Log Entry Type</label>
              <select
                aria-label="Filter by Log Entry Type"
                value={logTypeFilter}
                onChange={(e) => setLogTypeFilter(e.target.value as 'all' | 'operational' | 'test')}
                className="w-full bg-slate-800 text-slate-200 rounded-lg px-2.5 py-1.5 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
              >
                <option value="all">All Logs ({baseFilteredLogs.length})</option>
                <option value="operational">Operational Only ({operationalCount})</option>
                <option value="test">Test Logs Only ({testCount})</option>
              </select>
            </div>

            <div className="sm:col-span-5 flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400 font-medium flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-blue-400" />
                  <span>Date Range Filter:</span>
                </span>
                <input
                  type="date"
                  aria-label="Start Date"
                  value={startDateFilter}
                  onChange={(e) => setStartDateFilter(e.target.value)}
                  className="bg-slate-800 text-slate-200 rounded-lg px-2.5 py-1 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <span className="text-slate-500">to</span>
                <input
                  type="date"
                  aria-label="End Date"
                  value={endDateFilter}
                  onChange={(e) => setEndDateFilter(e.target.value)}
                  className="bg-slate-800 text-slate-200 rounded-lg px-2.5 py-1 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                {(startDateFilter || endDateFilter) && (
                  <button
                    type="button"
                    onClick={() => {
                      setStartDateFilter('');
                      setEndDateFilter('');
                    }}
                    className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-rose-300 border border-slate-700 font-semibold flex items-center gap-1 transition"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Reset Dates</span>
                  </button>
                )}
              </div>
              {(searchQuery ||
                selectedProjectFilter !== 'all' ||
                selectedEmployeeFilter !== 'all' ||
                selectedDisciplineFilter !== 'all' ||
                startDateFilter ||
                endDateFilter ||
                logTypeFilter !== 'all') && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedProjectFilter('all');
                    setSelectedEmployeeFilter('all');
                    setSelectedDisciplineFilter('all');
                    setStartDateFilter('');
                    setEndDateFilter('');
                    setLogTypeFilter('all');
                  }}
                  className="text-xs text-blue-400 hover:text-blue-300 underline font-medium"
                >
                  Clear All Filters
                </button>
              )}
            </div>
          </div>

          {/* Logs Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-800/80 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-700">
                  <tr>
                    <th className="p-3.5">Date</th>
                    <th className="p-3.5">Employee</th>
                    <th className="p-3.5">Project & Task</th>
                    <th className="p-3.5">Hours</th>
                    <th className="p-3.5">Notes</th>
                    <th className="p-3.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {filteredLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-slate-500">
                        <p className="text-sm font-semibold text-slate-400">No daily hour logs recorded.</p>
                        <p className="text-xs text-slate-500 mt-1">Click "Log Daily Hours" above to record hours for projects.</p>
                      </td>
                    </tr>
                  ) : (
                    filteredLogs.map((log) => {
                      const allowModify = canModifyLog(log);
                      return (
                        <tr key={log.id} className="hover:bg-slate-800/40 transition">
                          <td className="p-3.5 font-mono text-slate-400 whitespace-nowrap">
                            {log.date}
                          </td>
                          <td className="p-3.5 font-medium text-white whitespace-nowrap">
                            <div className="flex items-center gap-1.5">
                              <span>{log.employeeName}</span>
                              {log.isTestEntry && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                                  [TEST]
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-3.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-slate-200">{log.projectName}</span>
                              {log.isTestEntry && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                                  [TEST]
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-400">{log.taskName}</div>
                          </td>
                          <td className="p-3.5 font-bold text-sm whitespace-nowrap">
                            <div className="flex flex-col items-start gap-1">
                              <span className={log.isTestEntry ? 'text-amber-300' : 'text-blue-400'}>
                                Hours Logged: {Number(log.hoursLogged || 0).toFixed(1)}h
                              </span>
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                                Daily Hours Logged
                              </span>
                            </div>
                          </td>
                          <td className="p-3.5 text-slate-400 text-[11px] max-w-xs truncate" title={log.notes}>
                            {log.notes}
                          </td>
                          <td className="p-3.5 text-right whitespace-nowrap">
                            {isSuperAdmin && allowModify ? (
                              <div className="inline-flex items-center justify-end gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => openEditLogModal(log)}
                                  className="p-1.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 hover:text-blue-300 border border-blue-500/20 hover:border-blue-500/40 transition"
                                  title="Edit daily log entry"
                                  aria-label={`Edit log entry for ${log.employeeName}`}
                                >
                                  <Edit2 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDeleteCandidateLogs([log]);
                                    setLogToDelete(log);
                                  }}
                                  className="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 border border-rose-500/20 hover:border-rose-500/40 transition"
                                  title="Delete daily log entry"
                                  aria-label={`Delete log entry for ${log.employeeName}`}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                                Daily Hours Logged
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* EDIT DAILY LOG MODAL (Super Admin / Authorized Owner) */}
      {editingLog && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full my-8 text-slate-100 shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-600/20 text-blue-400 flex items-center justify-center">
                  <Edit2 className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Edit Daily Work Log</h3>
                  <p className="text-xs text-slate-400">
                    Modify logged hours for a specific day or project in Firestore
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingLog(null);
                  setEditCandidateLogs([]);
                }}
                className="p-1 text-slate-400 hover:text-white rounded-lg transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEditedLog} className="p-6 space-y-4 text-xs">
              {editCandidateLogs.length > 1 && (
                <div className="p-3 rounded-xl bg-slate-800/60 border border-slate-700/80">
                  <label className="block text-slate-300 font-semibold mb-1.5">
                    Select Daily Log Entry to Modify ({editCandidateLogs.length} entries)
                  </label>
                  <select
                    value={editingLog.id}
                    onChange={(e) => {
                      const chosen = editCandidateLogs.find((c) => c.id === e.target.value);
                      if (chosen) {
                        openEditLogModal(chosen, editCandidateLogs);
                      }
                    }}
                    className="w-full bg-slate-900 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
                  >
                    {editCandidateLogs.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.date} — {c.hoursLogged} hrs — {c.projectName} ({c.taskName || c.discipline})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Quick Week Day Selector for Matrix Modification */}
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-800">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    Current Week Day Selector ({currentWeekRange.label})
                  </span>
                  <span className="text-[11px] text-blue-400 font-mono">{editDate}</span>
                </div>
                <div className="grid grid-cols-7 gap-1.5">
                  {weekDays.map((wd) => {
                    const matchingLogForDay = editCandidateLogs.find(
                      (l) => getEffectiveLogDate(l, currentWeekRange) === wd.date || l.date === wd.date
                    );
                    const isSelectedDay = editDate === wd.date;
                    return (
                      <button
                        key={wd.date}
                        type="button"
                        onClick={() => {
                          if (matchingLogForDay) {
                            openEditLogModal(matchingLogForDay, editCandidateLogs);
                          } else {
                            setEditDate(wd.date);
                            if (editingLog.id !== '__new_matrix_log__' && editCandidateLogs.length > 0) {
                              setEditingLog({
                                ...editingLog,
                                id: '__new_matrix_log__',
                                date: wd.date,
                              });
                            }
                          }
                        }}
                        className={`py-1.5 px-1 rounded-lg border text-center transition ${
                          isSelectedDay
                            ? 'bg-blue-600/30 border-blue-500 text-white font-bold'
                            : matchingLogForDay
                            ? 'bg-slate-800 border-slate-700 text-blue-300 hover:border-slate-600'
                            : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700'
                        }`}
                      >
                        <div className="text-[10px] truncate">{wd.label.replace(' (Today)', '')}</div>
                        <div className="text-[10px] font-mono mt-0.5">
                          {matchingLogForDay ? `${matchingLogForDay.hoursLogged}h` : wd.dayNum}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Team Member</label>
                  <select
                    value={editEmployeeId}
                    onChange={(e) => setEditEmployeeId(e.target.value)}
                    disabled={!isSuperAdmin}
                    className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-75"
                  >
                    {!allTrackedEmployees.some((emp) => emp.id === editEmployeeId) && editEmployeeId && (
                      <option value={editEmployeeId}>{editingLog.employeeName}</option>
                    )}
                    {allTrackedEmployees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.name} ({emp.role})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 font-medium mb-1">Target Project</label>
                  <select
                    value={editProjectId}
                    onChange={(e) => setEditProjectId(e.target.value)}
                    className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {cleanProjectName(p.name)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Log Date</label>
                  <input
                    type="date"
                    value={editDate}
                    onChange={(e) => setEditDate(e.target.value)}
                    className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-slate-400 font-medium mb-1">Hours Spent</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    max="24"
                    value={editHours}
                    onChange={(e) => setEditHours(Number(e.target.value))}
                    className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 font-bold"
                    required
                  />
                </div>

                <div>
                  <label className="block text-slate-400 font-medium mb-1">LOD Level</label>
                  <select
                    value={editLodStage}
                    onChange={(e) => setEditLodStage(e.target.value as LODLevel)}
                    className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="LOD 100">LOD 100</option>
                    <option value="LOD 200">LOD 200</option>
                    <option value="LOD 300">LOD 300</option>
                    <option value="LOD 350">LOD 350</option>
                    <option value="LOD 400">LOD 400</option>
                    <option value="LOD 500">LOD 500</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Discipline</label>
                  <select
                    value={editDiscipline}
                    onChange={(e) => setEditDiscipline(e.target.value as Discipline)}
                    className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="BIM - ACS">BIM - ACS</option>
                    <option value="Structure">Structure</option>
                    <option value="MEP - HVAC">MEP - HVAC</option>
                    <option value="MEP - Electrical">MEP - Electrical</option>
                    <option value="MEP - Plumbing">MEP - Plumbing</option>
                    <option value="Façade / Envelope">Façade / Envelope</option>
                    <option value="Coordination & QA">Coordination & QA</option>
                    <option value="Fire Protection">Fire Protection</option>
                    <option value="AI & Automation">AI & Automation</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 font-medium mb-1">Activity Category</label>
                  <select
                    value={editActivityType}
                    onChange={(e) => setEditActivityType(e.target.value as ActivityType)}
                    className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="Drawing">Drawing</option>
                    <option value="Input Document study">Input Document study</option>
                    <option value="Estimation">Estimation</option>
                    <option value="QA & QC">QA & QC</option>
                    <option value="RFI , Mark up & issue Creation">RFI , Mark up & issue Creation</option>
                    <option value="Dynamo Script Making">Dynamo Script Making</option>
                    <option value="Addins & Pluggins Creation">Addins & Pluggins Creation</option>
                    <option value="3D Detailed Modeling">3D Detailed Modeling</option>
                    <option value="Clash Detection & Resolution">Clash Detection & Resolution</option>
                    <option value="Construction Documentation & Sheets">Construction Documentation & Sheets</option>
                    <option value="Parametric Family Creation">Parametric Family Creation</option>
                    <option value="Coordination & Navisworks Review">Coordination & Navisworks Review</option>
                    <option value="COBie & Asset Data Entry">COBie & Asset Data Entry</option>
                    <option value="Scan-to-BIM Point Cloud Modeling">Scan-to-BIM Point Cloud Modeling</option>
                    <option value="2D to 3D Conversion">2D to 3D Conversion</option>
                    <option value="AI & Automation">AI & Automation</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-400 font-medium mb-1">Work Notes & Technical Details</label>
                <textarea
                  rows={3}
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 leading-relaxed"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="editBillable"
                    checked={editBillable}
                    onChange={(e) => setEditBillable(e.target.checked)}
                    className="rounded bg-slate-800 border-slate-700 text-blue-600 focus:ring-blue-500"
                  />
                  <label htmlFor="editBillable" className="text-slate-300 select-none cursor-pointer">
                    Billable Client Project Hours
                  </label>
                </div>

                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30">
                  <input
                    type="checkbox"
                    id="editIsTestEntry"
                    checked={editIsTestEntry}
                    onChange={(e) => setEditIsTestEntry(e.target.checked)}
                    className="rounded bg-slate-800 border-amber-500/50 text-amber-500 focus:ring-amber-500"
                  />
                  <label htmlFor="editIsTestEntry" className="text-amber-300 font-semibold select-none cursor-pointer flex items-center gap-1.5">
                    <span>Mark as Test Entry</span>
                    {editIsTestEntry && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/25 text-amber-300 border border-amber-400/50">
                        [TEST]
                      </span>
                    )}
                  </label>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setEditingLog(null);
                    setEditCandidateLogs([]);
                  }}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold transition flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  <span>Save Changes</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DELETE DAILY LOG CONFIRMATION PROMPT MODAL */}
      {logToDelete && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full text-slate-100 shadow-2xl overflow-hidden p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-400 flex items-center justify-center shrink-0">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Delete this daily log entry?</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    This permanently deletes the timesheet record from Firestore.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setLogToDelete(null);
                  setDeleteCandidateLogs([]);
                }}
                className="p-1 text-slate-400 hover:text-white rounded-lg transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {deleteCandidateLogs.length > 1 && (
              <div className="text-xs">
                <label className="block text-slate-400 font-medium mb-1">
                  Select Daily Log Entry ({deleteCandidateLogs.length} entries)
                </label>
                <select
                  value={logToDelete.id}
                  onChange={(e) => {
                    const found = deleteCandidateLogs.find((c) => c.id === e.target.value);
                    if (found) setLogToDelete(found);
                  }}
                  className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-rose-500 cursor-pointer"
                >
                  {deleteCandidateLogs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.date} • {c.hoursLogged} hrs • {c.projectName}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="p-3.5 rounded-xl bg-slate-800/70 border border-slate-700/70 text-xs space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Employee:</span>
                <span className="font-semibold text-white flex items-center gap-1.5">
                  <span>{logToDelete.employeeName}</span>
                  {logToDelete.isTestEntry && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                      [TEST]
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Project:</span>
                <span className="font-semibold text-blue-300">{logToDelete.projectName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Date & Hours:</span>
                <span className="font-mono font-bold text-white">
                  {logToDelete.date} • {logToDelete.hoursLogged} hrs
                </span>
              </div>
            </div>

            <p className="text-xs text-slate-300">
              Delete this daily log entry? This action cannot be undone.
            </p>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => {
                  setLogToDelete(null);
                  setDeleteCandidateLogs([]);
                }}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteLog}
                className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold transition flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete Log</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
