import React, { useState, useMemo, useEffect } from 'react';
import {
  Clock,
  Layers,
  Users,
  AlertTriangle,
  CheckCircle2,
  Filter,
  Plus,
  Search,
  Calendar,
  AlertCircle,
  TrendingUp,
  ShieldCheck,
  ChevronDown,
  Trash2,
  Edit2,
  Check,
  X,
  Sparkles,
  ArrowRight,
  SlidersHorizontal,
  Info,
  Building,
  Briefcase
} from 'lucide-react';
import { useBimData, isUserSuperAdmin, getCurrentWeekRange, cleanProjectName, getMemberLabel } from '../context/BimDataContext';
import { db } from '../firebase/config';
import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
  deleteDoc,
} from 'firebase/firestore';
import {
  Discipline,
  LODLevel,
  BimTaskType,
  ActivityType,
  AllocationPriority,
  ResourceAllocationItem,
  BimProject,
  Employee,
  DailyWorkLog,
} from '../types';
import { generateRequestDocId } from '../auth/roleSync';

interface AssignHoursSystemProps {
  onSelectProject?: (project: BimProject) => void;
}

const matchProjectId = (idA?: string, idB?: string): boolean => {
  if (!idA || !idB) return false;
  if (idA === idB) return true;
  const normA = idA.startsWith('proj-') ? idA : idA.replace(/^p(\d+)$/, 'proj-$1');
  const normB = idB.startsWith('proj-') ? idB : idB.replace(/^p(\d+)$/, 'proj-$1');
  return normA === normB;
};

const getInitials = (name = '') =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'U';

const INITIAL_ALLOCATIONS: ResourceAllocationItem[] = [];

export const AssignHoursSystem: React.FC<AssignHoursSystemProps> = ({ onSelectProject }) => {
  const {
    projects,
    employees,
    workLogs,
    allWorkLogs,
    theme,
    currentUser,
    disciplineAssignments,
    handleMemberSelect: syncDisciplineMemberToFirestore,
  } = useBimData();
  const isLight = theme === 'light';
  const isSuperAdmin = isUserSuperAdmin(currentUser);
  const canManageAllocations = useMemo(() => {
    if (isSuperAdmin) return true;
    const role = (
      currentUser?.securityRole ||
      currentUser?.accessLevel ||
      currentUser?.role ||
      ''
    ).toLowerCase();
    const appRole = (currentUser?.appRole || '').toUpperCase();
    return (
      role.includes('admin') ||
      role.includes('director') ||
      role.includes('manager') ||
      appRole === 'SUPER_ADMIN' ||
      appRole === 'DIRECTOR' ||
      appRole === 'PROJECT_MANAGER'
    );
  }, [currentUser, isSuperAdmin]);
  // Real-time Firestore state for daily_logs / work_logs directly bound in AssignHoursSystem
  const [realtimeDailyLogs, setRealtimeDailyLogs] = useState<DailyWorkLog[]>([]);

  const activeWorkLogs = useMemo(() => {
    const mergedMap = new Map<string, DailyWorkLog>();
    (workLogs || []).forEach((l) => {
      if (l && l.id) mergedMap.set(l.id, l);
    });
    (allWorkLogs || []).forEach((l) => {
      if (l && l.id) mergedMap.set(l.id, l);
    });
    (realtimeDailyLogs || []).forEach((l) => {
      if (l && l.id) mergedMap.set(l.id, l);
    });
    return Array.from(mergedMap.values());
  }, [workLogs, allWorkLogs, realtimeDailyLogs]);

  const activeTeamMembers = useMemo(() => {
    const raw = (employees || []).filter((member) => !member.isDeleted && member.status !== 'deleted');
    const seen = new Set<string>();
    return raw.filter((member) => {
      const emailKey = (member.email || '').trim().toLowerCase();
      const idKey = (member.id || '').trim();
      const strippedId = idKey.replace(/^emp-/, '');
      const detId = emailKey ? generateRequestDocId(emailKey) : '';
      const nameKey = (member.name || '').trim().toLowerCase();
      if (
        (emailKey && seen.has(emailKey)) ||
        (idKey && seen.has(idKey)) ||
        (strippedId && seen.has(strippedId)) ||
        (detId && seen.has(detId)) ||
        (nameKey && seen.has(nameKey))
      ) {
        return false;
      }
      if (emailKey) seen.add(emailKey);
      if (idKey) seen.add(idKey);
      if (strippedId) seen.add(strippedId);
      if (detId) seen.add(detId);
      if (nameKey) seen.add(nameKey);
      return true;
    });
  }, [employees]);
  const activeMembers = activeTeamMembers;

  // Exclude allocations belonging to deleted members while keeping active allocations visible in real time
  const isLiveActiveMember = (item: ResourceAllocationItem) => {
    try {
      const saved = localStorage.getItem('bim_deleted_members_v1');
      if (saved) {
        const deletedSet = new Set<string>(JSON.parse(saved));
        const empId = (item.employeeId || item.memberId || '').trim().toLowerCase();
        const empIdStripped = empId.replace(/^emp-/, '');
        const email = (item.memberEmail || item.assignedToEmail || '').trim().toLowerCase();
        const name = (item.employeeName || '').trim().toLowerCase();
        if (
          (empId && deletedSet.has(empId)) ||
          (empIdStripped && deletedSet.has(empIdStripped)) ||
          (email && deletedSet.has(email)) ||
          (name && deletedSet.has(name))
        ) {
          return false;
        }
      }
    } catch {}
    return true;
  };

  // State
  const [allocations, setAllocations] = useState<ResourceAllocationItem[]>(() => {
    // Purge legacy allocations key if present
    try {
      localStorage.removeItem('bim_resource_allocations_v1');
    } catch {}

    const saved = localStorage.getItem('bim_resource_allocations_v2');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch (e) {
        return [];
      }
    }
    return [];
  });

  const hasInitialSeededRef = React.useRef(false);

  // Real-time Firestore onSnapshot listeners on BOTH assigned_hours (and project_assignments) AND daily_logs (and work_logs) collections
  useEffect(() => {
    let unsubAssignedHours: (() => void) | undefined;
    let unsubProjectAssignments: (() => void) | undefined;
    let unsubDailyLogs: (() => void) | undefined;
    let unsubWorkLogs: (() => void) | undefined;

    const assignedHoursMap = new Map<string, ResourceAllocationItem>();
    const projectAssignmentsMap = new Map<string, ResourceAllocationItem>();
    const dailyLogsMap = new Map<string, DailyWorkLog>();
    const workLogsMap = new Map<string, DailyWorkLog>();

    const parseSnapshotDoc = (docSnap: any): ResourceAllocationItem => {
      const data = docSnap.data();
      const matchedProj = projects.find((p) => matchProjectId(p.id, data.projectId));
      const resolvedEmpId = data.memberId || data.employeeId || data.assignedTo || '';
      const resolvedEmail = (data.assignedToEmail || data.memberEmail || '').trim().toLowerCase();
      const rawDocName = data.assignedToName || data.memberName || data.employeeName || '';

      const matchedEmpByIdOrEmail = employees.find(
        (e) =>
          (resolvedEmpId &&
            (e.id === resolvedEmpId ||
              e.id.replace(/^emp-/, '') === String(resolvedEmpId).replace(/^emp-/, ''))) ||
          (resolvedEmail && (e.email || '').trim().toLowerCase() === resolvedEmail)
      );
      const matchedEmp =
        matchedEmpByIdOrEmail ||
        employees.find(
          (e) =>
            rawDocName &&
            (e.name || '').trim().toLowerCase() === String(rawDocName).trim().toLowerCase()
        );
      const finalMemberId = matchedEmp?.id || resolvedEmpId;
      const finalEmail = matchedEmp?.email || data.assignedToEmail || data.memberEmail || '';
      const finalName =
        matchedEmpByIdOrEmail?.name ||
        data.assignedToName ||
        data.memberName ||
        matchedEmp?.name ||
        data.employeeName ||
        '';
      const activeMatchedName =
        matchedEmp && !matchedEmp.isDeleted && matchedEmp.status !== 'deleted'
          ? matchedEmp.name
          : employees.length === 0
          ? finalName
          : '';
      return {
        id: docSnap.id,
        projectId: data.projectId || matchedProj?.id || '',
        projectName: data.projectName || matchedProj?.name || 'Unassigned Project',
        employeeId: finalMemberId,
        memberId: finalMemberId,
        assignedTo: finalMemberId,
        employeeName: activeMatchedName || finalName,
        assignedToName: activeMatchedName,
        memberName: activeMatchedName || finalName,
        employeeRole: matchedEmp?.role || data.employeeRole || 'Editor',
        memberEmail: finalEmail,
        assignedToEmail: finalEmail,
        discipline: data.discipline || matchedEmp?.discipline || 'BIM - ACS',
        lod: data.lod || 'LOD 350',
        projectPhase: data.projectPhase || 'Design Development',
        taskType: data.taskType || '3D Modeling',
        targetElementOrZone: data.targetElementOrZone || 'MOD-AR-LVL01-ZONE-A',
        assignedHours: Number(data.assignedHours) || 0,
        viewFrequency: data.viewFrequency || 'Weekly',
        startDate: data.startDate || getCurrentWeekRange().startIso,
        dueDate: data.dueDate || getCurrentWeekRange().endIso,
        ...(data.priority ? { priority: data.priority } : {}),
        status: data.status || 'Allocated',
        notes: data.notes || '',
        updatedAt: data.updatedAt || '',
      };
    };

    const parseDailyLogDoc = (docSnap: any): DailyWorkLog => {
      const data = docSnap.data();
      const normalizedEmail = (data.memberEmail || data.userEmail || '').trim().toLowerCase();
      const resolvedMemberId = data.employeeId || data.memberId || data.userId || '';
      const resolvedCreatedAt =
        typeof data.createdAt === 'string'
          ? data.createdAt
          : typeof data.createdAt?.toDate === 'function'
          ? data.createdAt.toDate().toISOString()
          : typeof data.createdAt?.seconds === 'number'
          ? new Date(data.createdAt.seconds * 1000).toISOString()
          : data.timestamp || new Date().toISOString();
      return {
        id: docSnap.id,
        employeeId: resolvedMemberId,
        memberId: data.memberId || resolvedMemberId,
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
        timestamp: data.timestamp || resolvedCreatedAt,
        memberEmail: normalizedEmail,
        userEmail: normalizedEmail,
        userId: data.userId || resolvedMemberId,
        isTestEntry: Boolean(data.isTestEntry ?? false),
        loggedBy: data.loggedBy || normalizedEmail || data.employeeName || '',
        createdAt: resolvedCreatedAt,
      };
    };

    const syncMerged = (fromCache: boolean) => {
      const combined = new Map<string, ResourceAllocationItem>();
      projectAssignmentsMap.forEach((v, k) => combined.set(k, v));
      assignedHoursMap.forEach((v, k) => {
        const existing = combined.get(k);
        if (!existing || !existing.updatedAt || (v.updatedAt && v.updatedAt >= existing.updatedAt)) {
          combined.set(k, v);
        }
      });
      const remoteAllocations = Array.from(combined.values());

      if (remoteAllocations.length > 0 || !fromCache) {
        setAllocations((prev) => {
          if (!hasInitialSeededRef.current) {
            hasInitialSeededRef.current = true;
            if (remoteAllocations.length === 0 && prev.length > 0) {
              prev.forEach((item) => {
                const sanitized = JSON.parse(JSON.stringify(item));
                setDoc(doc(db, 'assigned_hours', item.id), sanitized, { merge: true }).catch(() => {});
                setDoc(doc(db, 'project_assignments', item.id), sanitized, { merge: true }).catch(() => {});
              });
              return prev;
            }
          }
          return remoteAllocations;
        });
      }
    };

    const syncMergedDailyLogs = () => {
      const combinedLogs = new Map<string, DailyWorkLog>();
      workLogsMap.forEach((v, k) => combinedLogs.set(k, v));
      dailyLogsMap.forEach((v, k) => combinedLogs.set(k, v));
      setRealtimeDailyLogs(Array.from(combinedLogs.values()));
    };

    try {
      unsubAssignedHours = onSnapshot(
        collection(db, 'assigned_hours'),
        (snapshot) => {
          assignedHoursMap.clear();
          snapshot.docs.forEach((docSnap) => {
            assignedHoursMap.set(docSnap.id, parseSnapshotDoc(docSnap));
          });
          syncMerged(snapshot.metadata.fromCache);
        },
        (err) => {
          console.warn('Firestore assigned_hours listener notice:', err);
        }
      );

      unsubProjectAssignments = onSnapshot(
        collection(db, 'project_assignments'),
        (snapshot) => {
          projectAssignmentsMap.clear();
          snapshot.docs.forEach((docSnap) => {
            projectAssignmentsMap.set(docSnap.id, parseSnapshotDoc(docSnap));
          });
          syncMerged(snapshot.metadata.fromCache);
        },
        (err) => {
          console.warn('Firestore project_assignments listener notice:', err);
        }
      );

      unsubDailyLogs = onSnapshot(
        collection(db, 'daily_logs'),
        (snapshot) => {
          dailyLogsMap.clear();
          snapshot.docs.forEach((docSnap) => {
            dailyLogsMap.set(docSnap.id, parseDailyLogDoc(docSnap));
          });
          syncMergedDailyLogs();
        },
        (err) => {
          console.warn('Firestore daily_logs listener in AssignHoursSystem notice:', err);
        }
      );

      unsubWorkLogs = onSnapshot(
        collection(db, 'work_logs'),
        (snapshot) => {
          workLogsMap.clear();
          snapshot.docs.forEach((docSnap) => {
            workLogsMap.set(docSnap.id, parseDailyLogDoc(docSnap));
          });
          syncMergedDailyLogs();
        },
        (err) => {
          console.warn('Firestore work_logs listener in AssignHoursSystem notice:', err);
        }
      );
    } catch (e) {
      console.warn('Firestore assigned_hours/daily_logs setup error:', e);
    }
    return () => {
      if (unsubAssignedHours) unsubAssignedHours();
      if (unsubProjectAssignments) unsubProjectAssignments();
      if (unsubDailyLogs) unsubDailyLogs();
      if (unsubWorkLogs) unsubWorkLogs();
    };
  }, [projects, employees]);

  // Sync allocations with activeMembers collection
  useEffect(() => {
    const handleAllocUpdate = (e: any) => {
      if (e.detail && Array.isArray(e.detail)) {
        setAllocations(isSuperAdmin || activeMembers.length === 0 ? e.detail : e.detail.filter(isLiveActiveMember));
      }
    };
    window.addEventListener('bim_resource_allocations_updated', handleAllocUpdate);
    return () => {
      window.removeEventListener('bim_resource_allocations_updated', handleAllocUpdate);
    };
  }, [activeMembers, isSuperAdmin]);

  // Persist to localStorage
  useEffect(() => {
    localStorage.setItem('bim_resource_allocations_v2', JSON.stringify(allocations));
  }, [allocations]);

  // Synchronize any rows with missing or legacy member bindings to their active selected member
  useEffect(() => {
    if (!canManageAllocations || activeTeamMembers.length === 0 || allocations.length === 0) return;

    let hasChanges = false;
    const itemsToSync: ResourceAllocationItem[] = [];

    const normalizedList = allocations.map((alloc) => {
      const matchedProject = projects.find((p) => matchProjectId(p.id, alloc.projectId));
      const resolvedProjectId = matchedProject?.id || alloc.projectId;

      const rawRowMemberId = (alloc.memberId || alloc.employeeId || alloc.assignedTo || '').trim();
      const strippedRowMemberId = rawRowMemberId.replace(/^emp-/, '');
      const rawRowEmail = (alloc.assignedToEmail || alloc.memberEmail || '').trim().toLowerCase();
      const rawRowName = (
        alloc.assignedToName ||
        alloc.memberName ||
        alloc.employeeName ||
        ''
      )
        .trim()
        .toLowerCase();

      const matchedById = rawRowMemberId
        ? activeTeamMembers.find(
            (emp) =>
              emp.id === rawRowMemberId || emp.id.replace(/^emp-/, '') === strippedRowMemberId
          )
        : undefined;
      const matchedByEmail =
        !matchedById && rawRowEmail
          ? activeTeamMembers.find((emp) => (emp.email || '').trim().toLowerCase() === rawRowEmail)
          : undefined;
      const matchedByName =
        !matchedById && !matchedByEmail && rawRowName
          ? activeTeamMembers.find((emp) => (emp.name || '').trim().toLowerCase() === rawRowName)
          : undefined;

      const directRowMember = matchedById || matchedByEmail || matchedByName;
      const selectedMember =
        directRowMember ||
        activeTeamMembers.find(
          (emp) =>
            emp.id === disciplineAssignments[`${resolvedProjectId}__${alloc.discipline}`] ||
            emp.id === disciplineAssignments[alloc.discipline]
        ) ||
        activeTeamMembers[0];

      if (!selectedMember) return alloc;

      if (
        alloc.employeeId !== selectedMember.id ||
        alloc.memberId !== selectedMember.id ||
        alloc.assignedToName !== selectedMember.name ||
        alloc.employeeName !== selectedMember.name
      ) {
        hasChanges = true;
        const healed: ResourceAllocationItem = {
          ...alloc,
          assignedTo: selectedMember.id,
          employeeId: selectedMember.id,
          memberId: selectedMember.id,
          assignedToName: selectedMember.name,
          memberName: selectedMember.name,
          employeeName: selectedMember.name,
          employeeRole: selectedMember.role || alloc.employeeRole,
          memberEmail: selectedMember.email || alloc.memberEmail,
          assignedToEmail: selectedMember.email || alloc.assignedToEmail,
          updatedAt: new Date().toISOString(),
        };
        itemsToSync.push(healed);
        return healed;
      }
      return alloc;
    });

    if (hasChanges) {
      setAllocations(normalizedList);
      localStorage.setItem('bim_resource_allocations_v2', JSON.stringify(normalizedList));
      window.dispatchEvent(
        new CustomEvent('bim_resource_allocations_updated', { detail: normalizedList })
      );
      itemsToSync.forEach((healed) => {
        const payload = {
          assignedTo: healed.employeeId,
          employeeId: healed.employeeId,
          memberId: healed.memberId || healed.employeeId,
          assignedToName: healed.assignedToName || healed.employeeName,
          memberName: healed.memberName || healed.employeeName,
          employeeName: healed.employeeName,
          employeeRole: healed.employeeRole || 'Editor',
          memberEmail: healed.memberEmail || '',
          assignedToEmail: healed.assignedToEmail || healed.memberEmail || '',
          updatedAt: healed.updatedAt || new Date().toISOString(),
        };
        const assignedHoursRef = doc(db, 'assigned_hours', healed.id);
        const assignRef = doc(db, 'project_assignments', healed.id);
        updateDoc(assignedHoursRef, payload).catch(() => {
          setDoc(assignedHoursRef, { ...healed, ...payload }, { merge: true }).catch(() => {});
        });
        updateDoc(assignRef, payload).catch(() => {
          setDoc(assignRef, { ...healed, ...payload }, { merge: true }).catch(() => {});
        });
      });
    }
  }, [allocations, activeTeamMembers, canManageAllocations, disciplineAssignments, projects]);

  const [selectedProjectId, setSelectedProjectId] = useState<string>('all');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('all');
  const [filterDiscipline, setFilterDiscipline] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterPriority, setFilterPriority] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [viewFrequency, setViewFrequency] = useState<'Daily' | 'Weekly'>('Weekly');

  // Modal / Add Form State
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [allocationToDelete, setAllocationToDelete] = useState<ResourceAllocationItem | null>(null);
  const [deleteSuccessNotice, setDeleteSuccessNotice] = useState<string | null>(null);

  // Form Inputs
  const [formProject, setFormProject] = useState(projects[0]?.id || 'p1');
  const [formEmployee, setFormEmployee] = useState(employees[0]?.id || 'emp-2');

  useEffect(() => {
    if (projects.length > 0 && !projects.some((p) => p.id === formProject)) {
      setFormProject(projects[0].id);
    }
  }, [projects, formProject]);

  useEffect(() => {
    if (activeTeamMembers.length > 0 && !activeTeamMembers.some((e) => e.id === formEmployee)) {
      setFormEmployee(activeTeamMembers[0].id);
    }
  }, [activeTeamMembers, formEmployee]);

  useEffect(() => {
    if (
      selectedEmployeeId !== 'all' &&
      !activeTeamMembers.some((e) => e.id === selectedEmployeeId)
    ) {
      setSelectedEmployeeId('all');
    }
  }, [activeTeamMembers, selectedEmployeeId]);

  const [formDiscipline, setFormDiscipline] = useState<ResourceAllocationItem['discipline']>('BIM - ACS');
  const [formLOD, setFormLOD] = useState<ResourceAllocationItem['lod']>('LOD 350');
  const [formPhase, setFormPhase] = useState<ResourceAllocationItem['projectPhase']>('Design Development');
  const [formTaskType, setFormTaskType] = useState<BimTaskType>('3D Modeling');
  const [formTargetZone, setFormTargetZone] = useState('MOD-AR-LVL01-ZONE-A');
  const [formHours, setFormHours] = useState<number>(20);
  const [formStartDate, setFormStartDate] = useState(() => getCurrentWeekRange().startIso);
  const [formDueDate, setFormDueDate] = useState(() => getCurrentWeekRange().endIso);
  const [formNotes, setFormNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Persist allocations to state, localStorage, and Firestore assigned_hours & project_assignments
  const saveAllocations = (newAllocations: ResourceAllocationItem[], changedItem?: ResourceAllocationItem) => {
    setAllocations(newAllocations);
    localStorage.setItem('bim_resource_allocations_v2', JSON.stringify(newAllocations));
    window.dispatchEvent(new CustomEvent('bim_resource_allocations_updated', { detail: newAllocations }));
    if (changedItem) {
      try {
        const resolvedName =
          changedItem.assignedToName || changedItem.memberName || changedItem.employeeName || '';
        const resolvedEmail = changedItem.assignedToEmail || changedItem.memberEmail || '';
        const resolvedMemberId = changedItem.memberId || changedItem.employeeId;
        const sanitized = {
          ...JSON.parse(JSON.stringify(changedItem)),
          assignedTo: resolvedMemberId,
          memberId: resolvedMemberId,
          employeeId: resolvedMemberId,
          assignedToName: resolvedName,
          memberName: resolvedName,
          employeeName: resolvedName,
          memberEmail: resolvedEmail,
          assignedToEmail: resolvedEmail,
          discipline: changedItem.discipline || 'BIM - ACS',
          updatedAt: new Date().toISOString(),
        };
        const assignedHoursRef = doc(db, 'assigned_hours', changedItem.id);
        updateDoc(assignedHoursRef, sanitized).catch(() => {
          setDoc(assignedHoursRef, sanitized, { merge: true }).catch((err) =>
            console.warn('Firestore saveAllocation assigned_hours sync notice:', err)
          );
        });
        const targetRef = doc(db, 'project_assignments', changedItem.id);
        updateDoc(targetRef, sanitized).catch(() => {
          setDoc(targetRef, sanitized, { merge: true }).catch((err) =>
            console.warn('Firestore saveAllocation project_assignments sync notice:', err)
          );
        });
      } catch (e) {
        console.warn('Firestore saveAllocation error:', e);
      }
    }
  };

  // Handle team member selection for a discipline or allocation row and persist via updateDoc in try/catch
  const handleMemberSelect = async (
    disciplineKey: string,
    memberId: string,
    allocationId?: string
  ) => {
    const emp =
      activeTeamMembers.find(
        (e) => e.id === memberId || e.id.replace(/^emp-/, '') === memberId.replace(/^emp-/, '')
      ) ||
      employees.find(
        (e) => e.id === memberId || e.id.replace(/^emp-/, '') === memberId.replace(/^emp-/, '')
      );
    const resolvedDiscipline = (
      emp?.discipline ||
      emp?.primaryDiscipline ||
      disciplineKey ||
      'BIM - ACS'
    ) as ResourceAllocationItem['discipline'];

    if (!allocationId) {
      setFormEmployee(memberId);
      if (emp?.discipline || emp?.primaryDiscipline) {
        setFormDiscipline(resolvedDiscipline);
      }
      try {
        await syncDisciplineMemberToFirestore(resolvedDiscipline, memberId, formProject);
      } catch (err) {
        console.warn('Firestore modal member select sync notice:', err);
      }
      return;
    }

    const nowIso = new Date().toISOString();
    const resolvedId = emp?.id || memberId;
    const resolvedName = emp?.name || '';
    const resolvedRole = emp?.role || 'Editor';
    const resolvedEmail = emp?.email || '';

    let updatedTarget: ResourceAllocationItem | undefined;
    const updatedList = allocations.map((item) => {
      if (item.id === allocationId) {
        const finalName = resolvedName || item.assignedToName || item.employeeName;
        const finalEmail = resolvedEmail || item.assignedToEmail || item.memberEmail;
        updatedTarget = {
          ...item,
          assignedTo: resolvedId,
          employeeId: resolvedId,
          memberId: resolvedId,
          assignedToName: finalName,
          memberName: finalName,
          employeeName: finalName,
          employeeRole: resolvedRole || item.employeeRole,
          memberEmail: finalEmail,
          assignedToEmail: finalEmail,
          discipline: resolvedDiscipline,
          updatedAt: nowIso,
        };
        return updatedTarget;
      }
      return item;
    });

    setAllocations(updatedList);
    localStorage.setItem('bim_resource_allocations_v2', JSON.stringify(updatedList));
    window.dispatchEvent(new CustomEvent('bim_resource_allocations_updated', { detail: updatedList }));

    try {
      const assignRef = doc(db, 'project_assignments', allocationId);
      const assignedHoursRef = doc(db, 'assigned_hours', allocationId);
      const finalName = resolvedName || updatedTarget?.assignedToName || updatedTarget?.employeeName || '';
      const finalEmail = resolvedEmail || updatedTarget?.assignedToEmail || updatedTarget?.memberEmail || '';
      const updatePayload = {
        assignedTo: resolvedId,
        employeeId: resolvedId,
        memberId: resolvedId,
        assignedToName: finalName,
        memberName: finalName,
        employeeName: finalName,
        employeeRole: resolvedRole || updatedTarget?.employeeRole || 'Editor',
        memberEmail: finalEmail,
        assignedToEmail: finalEmail,
        discipline: resolvedDiscipline,
        updatedAt: nowIso,
      };
      await Promise.all([
        updateDoc(assignedHoursRef, updatePayload).catch(() =>
          setDoc(assignedHoursRef, { ...(updatedTarget || {}), ...updatePayload }, { merge: true })
        ),
        updateDoc(assignRef, updatePayload).catch(() =>
          setDoc(assignRef, { ...(updatedTarget || {}), ...updatePayload }, { merge: true })
        ),
      ]);
      await syncDisciplineMemberToFirestore(
        resolvedDiscipline,
        resolvedId,
        updatedTarget?.projectId
      );
    } catch (err) {
      console.warn('Firestore handleMemberSelect updateDoc notice:', err);
    }
  };

  const isFullAccessRole = useMemo(() => {
    if (isSuperAdmin) return true;
    const role = (currentUser?.role || '').toUpperCase();
    const appRole = (currentUser?.appRole || '').toUpperCase();
    const accessLevel = (currentUser?.accessLevel || '').toUpperCase();
    const securityRole = (currentUser?.securityRole || '').toUpperCase();
    return (
      role === 'SUPER_ADMIN' ||
      role === 'DIRECTOR' ||
      role === 'SUPER ADMIN' ||
      appRole === 'SUPER_ADMIN' ||
      appRole === 'DIRECTOR' ||
      accessLevel === 'SUPER ADMIN' ||
      accessLevel === 'DIRECTOR' ||
      securityRole === 'SUPER ADMIN' ||
      securityRole === 'DIRECTOR'
    );
  }, [currentUser, isSuperAdmin]);

  const viewerMatchedEmployee = useMemo(() => {
    if (!currentUser) return undefined;
    const userId = (currentUser.id || '').trim();
    const userIdStripped = userId.replace(/^emp-/, '');
    const userEmail = (currentUser.email || '').toLowerCase().trim();
    const userName = (currentUser.name || '').toLowerCase().trim();
    return employees.find(
      (e) =>
        (userId && (e.id === userId || e.id.replace(/^emp-/, '') === userIdStripped)) ||
        (userEmail && (e.email || '').toLowerCase().trim() === userEmail) ||
        (userName && (e.name || '').toLowerCase().trim() === userName)
    );
  }, [currentUser, employees]);

  const visibleAssignments = useMemo(() => {
    const allAssignments = allocations.filter(isLiveActiveMember);
    if (
      isFullAccessRole ||
      currentUser?.role === 'SUPER_ADMIN' ||
      currentUser?.role === 'DIRECTOR'
    ) {
      return allAssignments;
    }
    if (!currentUser) return [];

    const userId = (currentUser.id || '').trim();
    const userIdStripped = userId.replace(/^emp-/, '');
    const userEmail = (currentUser.email || '').toLowerCase().trim();
    const userName = (currentUser.name || '').toLowerCase().trim();
    const matchedEmpId = (viewerMatchedEmployee?.id || '').trim();
    const matchedEmpIdStripped = matchedEmpId.replace(/^emp-/, '');

    return allAssignments.filter((item) => {
      const rawItem = item as any;
      if (
        (userId && (rawItem.memberId === userId || item.employeeId === userId)) ||
        (userEmail && rawItem.assignedToEmail === currentUser.email)
      ) {
        return true;
      }

      const itemEmpId = (item.employeeId || rawItem.memberId || '').trim();
      const itemEmpIdStripped = itemEmpId.replace(/^emp-/, '');
      if (
        (userIdStripped && itemEmpIdStripped === userIdStripped) ||
        (matchedEmpId && (itemEmpId === matchedEmpId || itemEmpIdStripped === matchedEmpIdStripped))
      ) {
        return true;
      }

      const itemEmail = (item.memberEmail || rawItem.assignedToEmail || '').toLowerCase().trim();
      if (userEmail && itemEmail && itemEmail === userEmail) {
        return true;
      }

      const itemName = (item.employeeName || '').toLowerCase().trim();
      if (userName && itemName && itemName === userName) {
        return true;
      }

      return false;
    });
  }, [allocations, currentUser, isFullAccessRole, viewerMatchedEmployee]);

  // All allocations synced from Firestore assigned_hours & project_assignments
  const liveActiveAllocations = useMemo(() => {
    return visibleAssignments;
  }, [visibleAssignments]);

  // Helper to get total weekly hours assigned to an employee
  const getEmployeeWeeklyHours = useMemo(() => {
    const map: Record<string, number> = {};
    liveActiveAllocations.forEach((alloc) => {
      if (alloc.status !== 'Completed') {
        map[alloc.employeeId] = (map[alloc.employeeId] || 0) + Number(alloc.assignedHours || 0);
      }
    });
    return map;
  }, [liveActiveAllocations]);

  // Cross-Collection Data Aggregation helper:
  // Dynamically aggregates matching records from daily_logs (activeWorkLogs) where
  // log.employeeId === assignment.memberId (or matching employee identifiers) and log.projectId === assignment.projectId
  const getLoggedHoursForAssignment = React.useCallback(
    (assignment: ResourceAllocationItem): number => {
      const rawAlloc = assignment as any;
      const assignmentMemberId = (assignment.memberId || rawAlloc.memberId || assignment.employeeId || rawAlloc.assignedTo || '').trim();
      const assignmentEmpId = (assignment.employeeId || assignmentMemberId).trim();
      const assignmentIdStripped = assignmentMemberId.replace(/^emp-/, '');
      const assignmentEmpIdStripped = assignmentEmpId.replace(/^emp-/, '');

      const matchedEmp = employees.find(
        (e) =>
          (assignmentMemberId && (e.id === assignmentMemberId || e.id.replace(/^emp-/, '') === assignmentIdStripped)) ||
          (assignmentEmpId && (e.id === assignmentEmpId || e.id.replace(/^emp-/, '') === assignmentEmpIdStripped)) ||
          (assignment.memberEmail && (e.email || '').trim().toLowerCase() === assignment.memberEmail.trim().toLowerCase()) ||
          (assignment.employeeName && (e.name || '').trim().toLowerCase() === assignment.employeeName.trim().toLowerCase())
      );

      const targetEmail = (
        assignment.memberEmail ||
        rawAlloc.assignedToEmail ||
        matchedEmp?.email ||
        ''
      )
        .trim()
        .toLowerCase();
      const detEmailId = targetEmail ? generateRequestDocId(targetEmail) : '';
      const targetName = (assignment.employeeName || matchedEmp?.name || '').trim().toLowerCase();

      const matchedProj = projects.find((p) => matchProjectId(p.id, assignment.projectId));
      const targetProjNameNorm = (matchedProj?.name || assignment.projectName || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');

      const matchingLogs = activeWorkLogs.filter((log) => {
        // 1. Project match: log.projectId === assignment.projectId (or normalized project ID/name)
        const sameProjId =
          log.projectId === assignment.projectId || matchProjectId(log.projectId, assignment.projectId);
        const logProjNameNorm = (log.projectName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const sameProjName =
          Boolean(targetProjNameNorm) &&
          targetProjNameNorm !== 'unassignedproject' &&
          targetProjNameNorm !== 'bimproject' &&
          logProjNameNorm === targetProjNameNorm;

        if (!sameProjId && !sameProjName) return false;

        // 2. Member match: log.employeeId === assignment.memberId (plus normalized ID, email, or name)
        const logEmpId = (log.employeeId || '').trim();
        const logMemberId = ((log as any).memberId || log.userId || '').trim();
        const logEmpIdStripped = logEmpId.replace(/^emp-/, '');
        const logMemberIdStripped = logMemberId.replace(/^emp-/, '');

        const directMemberMatch =
          Boolean(assignmentMemberId) &&
          (log.employeeId === assignmentMemberId ||
            log.employeeId === assignmentEmpId ||
            logMemberId === assignmentMemberId ||
            logMemberId === assignmentEmpId);

        const strippedIdMatch =
          (Boolean(assignmentIdStripped) &&
            (logEmpIdStripped === assignmentIdStripped ||
              logMemberIdStripped === assignmentIdStripped)) ||
          (Boolean(assignmentEmpIdStripped) &&
            (logEmpIdStripped === assignmentEmpIdStripped ||
              logMemberIdStripped === assignmentEmpIdStripped)) ||
          (Boolean(detEmailId) &&
            (logEmpIdStripped === detEmailId || logMemberIdStripped === detEmailId)) ||
          (Boolean(matchedEmp?.id) &&
            (logEmpId === matchedEmp.id ||
              logEmpIdStripped === matchedEmp.id.replace(/^emp-/, '')));

        const logEmail = (log.memberEmail || (log as any).userEmail || log.loggedBy || '')
          .trim()
          .toLowerCase();
        const emailMatch = Boolean(targetEmail) && Boolean(logEmail) && logEmail === targetEmail;

        const logName = (log.employeeName || '').trim().toLowerCase();
        const nameMatch = Boolean(targetName) && Boolean(logName) && logName === targetName;

        return directMemberMatch || strippedIdMatch || emailMatch || nameMatch;
      });

      const operationalLogs = matchingLogs.filter((l) => !l.isTestEntry);
      const targetList = operationalLogs.length > 0 ? operationalLogs : matchingLogs;
      return targetList.reduce((sum, w) => sum + (Number(w.hoursLogged ?? (w as any).hours) || 0), 0);
    },
    [activeWorkLogs, employees, projects]
  );

  // Overall Workspace Metrics & Efficiency Dashboard based on table parameters
  const workspaceMetrics = useMemo(() => {
    let budgetHours = 0;
    if (selectedProjectId === 'all') {
      if (selectedEmployeeId !== 'all') {
        const emp = employees.find((e) => e.id === selectedEmployeeId);
        budgetHours = emp?.weeklyCapacityHours || 40;
      } else {
        budgetHours = projects.reduce((sum, p) => sum + (p.totalEstimatedHours || 0), 0);
      }
    } else {
      const proj = projects.find((p) => matchProjectId(p.id, selectedProjectId));
      budgetHours = proj?.totalEstimatedHours || 0;
    }

    const relevantAllocations = selectedProjectId === 'all'
      ? liveActiveAllocations
      : liveActiveAllocations.filter((a) => matchProjectId(a.projectId, selectedProjectId));

    const filteredByEmployee = !isFullAccessRole || selectedEmployeeId === 'all'
      ? relevantAllocations
      : relevantAllocations.filter((a) => a.employeeId === selectedEmployeeId);

    const allocatedHours = filteredByEmployee.reduce((sum, a) => sum + (Number(a.assignedHours) || 0), 0);

    // Dynamically aggregate total logged hours across daily_logs for all matching assignments
    const loggedHours = filteredByEmployee.reduce(
      (sum, alloc) => sum + getLoggedHoursForAssignment(alloc),
      0
    );

    // Dynamic Available Remaining Hours: Assigned Hours - Logged Hours
    const remainingHours = Number((allocatedHours - loggedHours).toFixed(1));
    const utilizationPct = budgetHours > 0 ? Math.round((allocatedHours / budgetHours) * 100) : 0;

    // Efficiency & Status Metrics
    const completedTasks = filteredByEmployee.filter((a) => a.status === 'Completed');
    const completedHours = completedTasks.reduce((sum, a) => sum + (Number(a.assignedHours) || 0), 0);
    const inProgressTasks = filteredByEmployee.filter((a) => a.status === 'In Progress');
    const inProgressHours = inProgressTasks.reduce((sum, a) => sum + (Number(a.assignedHours) || 0), 0);
    const criticalTasks = filteredByEmployee.filter((a) => a.priority === 'Critical' || a.priority === 'High');
    const delayedTasks = filteredByEmployee.filter((a) => a.status === 'Delayed');

    const completionRate = allocatedHours > 0 ? Math.round((completedHours / allocatedHours) * 100) : 0;

    // Discipline breakdown
    const disciplineBreakdown: Record<string, number> = {
      Architectural: 0,
      Structural: 0,
      MEP: 0,
      Infrastructure: 0,
      'Coordination & QA': 0,
      'AI & Automation': 0,
      Estimation: 0
    };

    filteredByEmployee.forEach((a) => {
      if (disciplineBreakdown[a.discipline] !== undefined) {
        disciplineBreakdown[a.discipline] += Number(a.assignedHours || 0);
      }
    });

    // Priority breakdown
    const priorityBreakdown = {
      Critical: filteredByEmployee.filter(a => a.priority === 'Critical').length,
      High: filteredByEmployee.filter(a => a.priority === 'High').length,
      Medium: filteredByEmployee.filter(a => a.priority === 'Medium').length,
      Low: filteredByEmployee.filter(a => a.priority === 'Low').length,
    };

    // Overallocated staff count
    const overallocatedStaff = Object.entries(getEmployeeWeeklyHours).filter(([_, hrs]) => Number(hrs) > 40).length;

    return {
      budgetHours,
      allocatedHours,
      loggedHours,
      remainingHours,
      utilizationPct,
      disciplineBreakdown,
      overallocatedStaff,
      completedHours,
      inProgressHours,
      completedCount: completedTasks.length,
      inProgressCount: inProgressTasks.length,
      delayedCount: delayedTasks.length,
      criticalCount: criticalTasks.length,
      completionRate,
      priorityBreakdown
    };
  }, [projects, employees, liveActiveAllocations, activeWorkLogs, selectedProjectId, selectedEmployeeId, getEmployeeWeeklyHours, getLoggedHoursForAssignment]);

  // Filtered Allocations based on 2 Dropdowns (Project + Team Member) and Search
  const filteredAllocations = useMemo(() => {
    return visibleAssignments.filter((a) => {
      const matchesProj = selectedProjectId === 'all' || matchProjectId(a.projectId, selectedProjectId);
      const matchesEmp = !isFullAccessRole || selectedEmployeeId === 'all' || a.employeeId === selectedEmployeeId;
      const matchesDisc = filterDiscipline === 'all' || a.discipline === filterDiscipline;
      const matchesStatus = filterStatus === 'all' || a.status === filterStatus;
      const matchesPriority = filterPriority === 'all' || a.priority === filterPriority;
      const q = searchQuery.toLowerCase();
      const matchesSearch =
        (a.projectName || '').toLowerCase().includes(q) ||
        (a.employeeName || '').toLowerCase().includes(q) ||
        (a.employeeRole || '').toLowerCase().includes(q) ||
        (a.discipline || '').toLowerCase().includes(q) ||
        (a.status || '').toLowerCase().includes(q) ||
        (a.priority || '').toLowerCase().includes(q);

      return matchesProj && matchesEmp && matchesDisc && matchesStatus && matchesPriority && matchesSearch;
    });
  }, [visibleAssignments, isFullAccessRole, selectedProjectId, selectedEmployeeId, filterDiscipline, filterStatus, filterPriority, searchQuery]);

  // Handle Form Submission
  const handleAddAllocation = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    // Validation Guards
    if (formHours <= 0) {
      setFormError('Assigned hours must be greater than 0.');
      return;
    }
    if (new Date(formDueDate) < new Date(formStartDate)) {
      setFormError('Due date cannot be earlier than start date.');
      return;
    }

    const proj = projects.find((p) => p.id === formProject || matchProjectId(p.id, formProject)) || projects[0];
    const emp = employees.find((e) => e.id === formEmployee) || employees[0];

    if (!proj) {
      setFormError('Please select a valid target project.');
      return;
    }
    if (!emp) {
      setFormError('Please select an active team member.');
      return;
    }

    const newItem: ResourceAllocationItem = {
      id: `alloc-${Date.now()}`,
      projectId: proj.id,
      projectName: proj.name,
      employeeId: emp.id,
      memberId: emp.id,
      assignedTo: emp.id,
      employeeName: emp.name,
      assignedToName: emp.name,
      memberName: emp.name,
      employeeRole: emp.role,
      memberEmail: emp.email,
      assignedToEmail: emp.email,
      discipline: formDiscipline,
      projectPhase: formPhase,
      taskType: formTaskType,
      assignedHours: Number(formHours),
      viewFrequency,
      startDate: formStartDate,
      dueDate: formDueDate,
      status: 'Allocated',
      notes: formNotes,
      updatedAt: new Date().toISOString(),
    };

    saveAllocations([newItem, ...allocations], newItem);
    setShowAddModal(false);
    setFormNotes('');
  };

  // Inline Quick Update for Project
  const handleInlineProjectChange = (id: string, newProjectId: string) => {
    const proj = projects.find((p) => p.id === newProjectId || matchProjectId(p.id, newProjectId));
    if (!proj) return;
    let updatedItem: ResourceAllocationItem | undefined;
    const updated = allocations.map((a) => {
      if (a.id === id) {
        updatedItem = { ...a, projectId: proj.id, projectName: proj.name };
        return updatedItem;
      }
      return a;
    });
    saveAllocations(updated, updatedItem);
  };

  // Inline Quick Update for hours
  const handleInlineHoursChange = (id: string, newHours: number) => {
    if (newHours < 0) return;
    let updatedItem: ResourceAllocationItem | undefined;
    const updated = allocations.map((a) => {
      if (a.id === id) {
        updatedItem = { ...a, assignedHours: newHours };
        return updatedItem;
      }
      return a;
    });
    saveAllocations(updated, updatedItem);
  };

  // Inline Priority Update
  const handleInlinePriorityChange = (id: string, priority: AllocationPriority) => {
    let updatedItem: ResourceAllocationItem | undefined;
    const updated = allocations.map((a) => {
      if (a.id === id) {
        updatedItem = { ...a, priority };
        return updatedItem;
      }
      return a;
    });
    saveAllocations(updated, updatedItem);
  };

  // Inline Status Update
  const handleInlineStatusChange = (id: string, status: ResourceAllocationItem['status']) => {
    let updatedItem: ResourceAllocationItem | undefined;
    const updated = allocations.map((a) => {
      if (a.id === id) {
        updatedItem = { ...a, status };
        return updatedItem;
      }
      return a;
    });
    saveAllocations(updated, updatedItem);
  };

  // Delete Allocation with Firestore deleteDoc
  const handleDeleteAllocation = async (id: string) => {
    const updated = allocations.filter((a) => a.id !== id);
    saveAllocations(updated);
    setAllocationToDelete(null);
    setDeleteSuccessNotice('Record successfully deleted');
    window.setTimeout(() => {
      setDeleteSuccessNotice((cur) => (cur === 'Record successfully deleted' ? null : cur));
    }, 4000);
    try {
      await deleteDoc(doc(db, 'assigned_hours', id));
    } catch (err) {
      console.warn('Firestore deleteAllocation assigned_hours notice:', err);
    }
    try {
      await deleteDoc(doc(db, 'allocations', id));
    } catch (err) {
      console.warn('Firestore deleteAllocation allocations notice:', err);
    }
    try {
      await deleteDoc(doc(db, 'project_assignments', id));
    } catch (err) {
      console.warn('Firestore deleteAllocation project_assignments notice:', err);
    }
  };

  // Discipline Badge Styles
  const getDisciplineBadge = (disc: string) => {
    switch (disc) {
      case 'Architectural':
        return 'bg-blue-500/10 text-blue-400 border border-blue-500/30';
      case 'Structural':
        return 'bg-rose-500/10 text-rose-400 border border-rose-500/30';
      case 'MEP':
        return 'bg-amber-500/10 text-amber-400 border border-amber-500/30';
      case 'Infrastructure':
        return 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30';
      case 'Coordination & QA':
        return 'bg-purple-500/10 text-purple-400 border border-purple-500/30';
      default:
        return 'bg-slate-700 text-slate-300 border border-slate-600';
    }
  };

  // Priority Badge Styles
  const getPriorityBadge = (priority: AllocationPriority) => {
    switch (priority) {
      case 'Critical':
        return 'bg-red-500/20 text-red-400 border border-red-500/40 font-bold';
      case 'High':
        return 'bg-orange-500/20 text-orange-400 border border-orange-500/40';
      case 'Medium':
        return 'bg-blue-500/20 text-blue-300 border border-blue-500/30';
      case 'Low':
        return 'bg-slate-700/50 text-slate-400 border border-slate-600/50';
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {deleteSuccessNotice && (
        <div
          role="status"
          className="fixed top-5 right-5 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-slate-900 border border-emerald-500/40 text-emerald-300 shadow-2xl text-xs font-semibold animate-in fade-in slide-in-from-top-2"
        >
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{deleteSuccessNotice}</span>
          <button
            type="button"
            onClick={() => setDeleteSuccessNotice(null)}
            className="ml-2 p-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition"
            aria-label="Dismiss notification"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {/* 1. WORKSPACE & METRICS HEADER */}
      <div className={`p-5 rounded-2xl border ${
        isLight ? 'bg-white border-slate-200 shadow-sm' : 'bg-slate-900 border-slate-800'
      }`}>
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-blue-500/10 text-blue-400 border border-blue-500/20 flex items-center gap-1">
                <SlidersHorizontal className="w-3 h-3" />
                BIM Efficiency & Resource Engine
              </span>
              {workspaceMetrics.overallocatedStaff > 0 && (
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-red-500/15 text-red-400 border border-red-500/30 flex items-center gap-1 animate-pulse">
                  <AlertTriangle className="w-3 h-3" />
                  {workspaceMetrics.overallocatedStaff} Overallocated Specialists
                </span>
              )}
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight mt-1.5 flex items-center gap-2">
              Assigned Hours System
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Track allocated hours, timeline efficiency, delivery throughput, and specialist capacities across all BIM disciplines.
            </p>
          </div>

          {/* Action & View Frequency */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Daily / Weekly toggle */}
            <div className="flex items-center bg-slate-800 p-1 rounded-lg border border-slate-700 text-xs">
              <button
                onClick={() => setViewFrequency('Daily')}
                className={`px-3 py-1 rounded font-semibold transition ${
                  viewFrequency === 'Daily' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Daily
              </button>
              <button
                onClick={() => setViewFrequency('Weekly')}
                className={`px-3 py-1 rounded font-semibold transition ${
                  viewFrequency === 'Weekly' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Weekly
              </button>
            </div>

            {canManageAllocations && (
              <button
                onClick={() => setShowAddModal(true)}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-md transition"
              >
                <Plus className="w-4 h-4" />
                <span>Assign New Hours</span>
              </button>
            )}
          </div>
        </div>

        {/* Primary Top Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 mt-5 pt-5 border-t border-slate-800">
          <div className="p-3.5 bg-slate-800/60 rounded-xl border border-slate-700/60">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                Assigned / Allocated Hours
              </span>
              {workspaceMetrics.allocatedHours > 0 && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30">
                  {canManageAllocations ? 'Work Assigned to Team' : 'Work Assigned to You'}
                </span>
              )}
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <div className="text-xl font-bold text-blue-400 font-mono">
                {workspaceMetrics.allocatedHours.toFixed(1)} <span className="text-xs font-normal text-slate-400">hrs</span>
              </div>
              <Clock className="w-4 h-4 text-blue-400" />
            </div>
            <div className="w-full bg-slate-700 h-1.5 rounded-full overflow-hidden mt-1.5">
              <div
                className="bg-blue-500 h-full rounded-full"
                style={{ width: `${Math.min(100, workspaceMetrics.utilizationPct)}%` }}
              />
            </div>
          </div>

          <div className="p-3.5 bg-slate-800/60 rounded-xl border border-slate-700/60">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                Available Remaining Hours
              </span>
              <span className="text-[10px] font-semibold font-mono bg-emerald-500/15 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/30">
                {workspaceMetrics.loggedHours > 0
                  ? `Daily Hours Logged • Hours Logged: ${workspaceMetrics.loggedHours.toFixed(1)}h`
                  : `Hours Logged: 0.0h`}
              </span>
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <div className={`text-xl font-bold font-mono ${
                workspaceMetrics.remainingHours < 0
                  ? 'text-rose-400'
                  : workspaceMetrics.remainingHours < 20
                  ? 'text-amber-400'
                  : 'text-emerald-400'
              }`}>
                {workspaceMetrics.remainingHours.toFixed(1)} <span className="text-xs font-normal text-slate-400">hrs</span>
              </div>
              <CheckCircle2 className={`w-4 h-4 ${
                workspaceMetrics.remainingHours < 0
                  ? 'text-rose-400'
                  : workspaceMetrics.remainingHours < 20
                  ? 'text-amber-400'
                  : 'text-emerald-400'
              }`} />
            </div>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center justify-between">
              <span>{workspaceMetrics.allocatedHours.toFixed(1)}h assigned − {workspaceMetrics.loggedHours.toFixed(1)}h logged</span>
              <span className="font-mono text-slate-500">
                {workspaceMetrics.allocatedHours > 0
                  ? `${Math.round((workspaceMetrics.loggedHours / workspaceMetrics.allocatedHours) * 100)}% logged`
                  : '0% logged'}
              </span>
            </p>
          </div>

          <div className="p-3.5 bg-slate-800/60 rounded-xl border border-slate-700/60">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Efficiency & Completion
            </span>
            <div className="flex items-baseline justify-between mt-1">
              <div className="text-xl font-bold text-purple-400 font-mono">
                {workspaceMetrics.completionRate}%
              </div>
              <TrendingUp className="w-4 h-4 text-purple-400" />
            </div>
            <p className="text-[10px] text-slate-400 mt-1">
              {workspaceMetrics.completedHours}h completed / {workspaceMetrics.inProgressHours}h in progress
            </p>
          </div>
        </div>
      </div>

      {/* REDESIGNED SEARCH & 2-DROPDOWN FILTER SYSTEM */}
      <div className={`p-4 rounded-xl border flex flex-col lg:flex-row items-center justify-between gap-3 ${
        isLight ? 'bg-white border-slate-200' : 'bg-slate-900/90 border-slate-800'
      }`}>
        {/* Search */}
        <div className="relative w-full lg:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search assignee, project, discipline, status..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-800 text-slate-200 text-xs rounded-lg pl-9 pr-3 py-2 border border-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-500"
          />
        </div>

        {/* 2-Dropdown Filter System (Project Dropdown + Team Member Dropdown) */}
        <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto justify-end text-xs">
          {/* Dropdown 1: Project Filter */}
          <div className="flex items-center gap-1.5 bg-slate-800 px-3 py-2 rounded-lg border border-slate-700">
            <Building className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mr-1">Project:</span>
            <select
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              className="bg-transparent text-slate-200 text-xs font-semibold focus:outline-none cursor-pointer"
            >
              <option value="all" className="bg-slate-900">All Projects ({projects.length})</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id} className="bg-slate-900">
                  {cleanProjectName(p.name)}
                </option>
              ))}
            </select>
          </div>

          {/* Dropdown 2: Team Member Filter */}
          <div className="flex items-center gap-1.5 bg-slate-800 px-3 py-2 rounded-lg border border-slate-700">
            <Users className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mr-1">Team Member:</span>
            {isFullAccessRole ? (
              <select
                value={selectedEmployeeId}
                onChange={(e) => setSelectedEmployeeId(e.target.value)}
                className="bg-transparent text-slate-200 text-xs font-semibold focus:outline-none cursor-pointer"
              >
                <option value="all" className="bg-slate-900">All Team Members ({activeTeamMembers.length})</option>
                {activeTeamMembers.map((e) => (
                  <option key={e.id} value={e.id} className="bg-slate-900">
                    {e.name}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={viewerMatchedEmployee?.id || currentUser?.id || 'viewer-self'}
                disabled
                aria-label="Team Member Filter (Locked to current user)"
                className="bg-transparent text-slate-200 text-xs font-semibold focus:outline-none cursor-default opacity-90"
              >
                <option value={viewerMatchedEmployee?.id || currentUser?.id || 'viewer-self'} className="bg-slate-900">
                  {viewerMatchedEmployee?.name || currentUser?.name || currentUser?.email || 'My Assigned Tasks'}
                </option>
              </select>
            )}
          </div>

          {/* Quick Clear Filters button if filtered */}
          {(selectedProjectId !== 'all' || (isFullAccessRole && selectedEmployeeId !== 'all') || searchQuery) && (
            <button
              onClick={() => {
                setSelectedProjectId('all');
                if (isFullAccessRole) {
                  setSelectedEmployeeId('all');
                }
                setSearchQuery('');
              }}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-medium border border-slate-700 transition"
            >
              Clear Filters
            </button>
          )}
        </div>
      </div>

      {/* 2. EFFICIENCY MANAGEMENT DATA GRID TABLE */}
      <div className={`rounded-xl border overflow-hidden shadow-sm ${
        isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
      }`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-800/90 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-700 text-[11px]">
              <tr>
                <th className="py-3 px-3.5 min-w-[200px]">Team Member</th>
                <th className="py-3 px-3 min-w-[180px]">Project</th>
                <th className="py-3 px-3 min-w-[130px]">Assigned Hours</th>
                <th className="py-3 px-3 min-w-[130px]">Logged Hours</th>
                <th className="py-3 px-3 min-w-[160px]">Timeline (Start - Due)</th>
                <th className="py-3 px-3.5 text-right min-w-[90px]">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 font-normal">
              {filteredAllocations.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500">
                    <p className="text-sm font-semibold text-slate-400">No resource hour allocations found.</p>
                    <p className="text-xs text-slate-500 mt-1">Click "Assign Hours" above to allocate hours to project members.</p>
                  </td>
                </tr>
              ) : (
                filteredAllocations.map((alloc) => {
                  if (!isSuperAdmin && activeMembers.length > 0 && !isLiveActiveMember(alloc)) return null;

                  const matchedProject = projects.find((p) => matchProjectId(p.id, alloc.projectId));
                  const resolvedProjectId = matchedProject?.id || alloc.projectId;
                  const resolvedProjectName = matchedProject?.name || alloc.projectName || 'Unassigned Project';

                  const rawRowMemberId = (alloc.memberId || alloc.employeeId || alloc.assignedTo || '').trim();
                  const strippedRowMemberId = rawRowMemberId.replace(/^emp-/, '');
                  const rawRowEmail = (alloc.assignedToEmail || alloc.memberEmail || '').trim().toLowerCase();
                  const rawRowName = (
                    alloc.assignedToName ||
                    alloc.memberName ||
                    alloc.employeeName ||
                    ''
                  )
                    .trim()
                    .toLowerCase();

                  const matchedById = rawRowMemberId
                    ? activeTeamMembers.find(
                        (emp) =>
                          emp.id === rawRowMemberId ||
                          emp.id.replace(/^emp-/, '') === strippedRowMemberId
                      ) ||
                      employees.find(
                        (emp) =>
                          emp.id === rawRowMemberId ||
                          emp.id.replace(/^emp-/, '') === strippedRowMemberId
                      )
                    : undefined;

                  const matchedByEmail =
                    !matchedById && rawRowEmail
                      ? activeTeamMembers.find(
                          (emp) => (emp.email || '').trim().toLowerCase() === rawRowEmail
                        ) ||
                        employees.find(
                          (emp) => (emp.email || '').trim().toLowerCase() === rawRowEmail
                        )
                      : undefined;

                  const matchedByName =
                    !matchedById && !matchedByEmail && rawRowName
                      ? activeTeamMembers.find(
                          (emp) => (emp.name || '').trim().toLowerCase() === rawRowName
                        ) ||
                        employees.find(
                          (emp) => (emp.name || '').trim().toLowerCase() === rawRowName
                        )
                      : undefined;

                  const directRowMember = matchedById || matchedByEmail || matchedByName;
                  const isDirectMemberActive =
                    directRowMember && activeTeamMembers.some((emp) => emp.id === directRowMember.id);

                  const selectedMember = isDirectMemberActive
                    ? directRowMember
                    : activeTeamMembers.find(
                        (emp) =>
                          emp.id ===
                            disciplineAssignments[`${resolvedProjectId}__${alloc.discipline}`] ||
                          emp.id === disciplineAssignments[alloc.discipline]
                      ) ||
                      activeTeamMembers[0] ||
                      directRowMember;

                  const row =
                    selectedMember && alloc.assignedToName !== selectedMember.name
                      ? {
                          ...alloc,
                          employeeId: selectedMember.id,
                          memberId: selectedMember.id,
                          assignedToName: selectedMember.name,
                          memberName: selectedMember.name,
                          employeeName: selectedMember.name,
                          memberEmail: selectedMember.email || alloc.memberEmail,
                          assignedToEmail: selectedMember.email || alloc.assignedToEmail,
                        }
                      : alloc;

                  // Dynamic row-level name binding for status badge and avatar initials
                  const assignedName = row.assignedToName || selectedMember?.name || 'Member';
                  const badgeText = `Work Assigned to ${assignedName}`;
                  const avatarInitials = getInitials(assignedName);

                  const loggedHours = getLoggedHoursForAssignment(row);

                  return (
                    <tr
                      key={alloc.id}
                      className="hover:bg-slate-800/40 transition group"
                    >
                      {/* Team Member (Synced with Firestore assignedTo / discipline) */}
                      <td className="py-3 px-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center font-bold text-white text-[11px] shrink-0 shadow-xs">
                            {avatarInitials}
                          </div>
                          <div>
                            {canManageAllocations && activeTeamMembers.length > 0 ? (
                              <select
                                aria-label={`Assigned team member for ${alloc.discipline || 'BIM - ACS'}`}
                                value={selectedMember?.id || row.employeeId || ''}
                                onChange={(e) =>
                                  handleMemberSelect(
                                    alloc.discipline || 'BIM - ACS',
                                    e.target.value,
                                    alloc.id
                                  )
                                }
                                className="px-2 py-1 text-[13px] font-semibold rounded bg-slate-800 border border-slate-700 text-white focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
                              >
                                {activeTeamMembers.map((emp) => (
                                  <option key={emp.id} value={emp.id} className="bg-slate-900">
                                    {emp.name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <div className="font-semibold text-white text-[13px]">
                                {assignedName}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Project (Synced with Firestore projectId / projectName) */}
                      <td className="py-3 px-3">
                        {canManageAllocations ? (
                          <div className="flex items-center gap-1.5">
                            <Building className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                            <select
                              aria-label={`Assigned project for ${assignedName}`}
                              value={resolvedProjectId}
                              onChange={(e) => handleInlineProjectChange(alloc.id, e.target.value)}
                              className="px-2 py-1 text-xs font-semibold rounded bg-slate-800 border border-slate-700 text-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer max-w-[200px] truncate"
                            >
                              {!projects.some((p) => p.id === resolvedProjectId) && resolvedProjectId && (
                                <option value={resolvedProjectId} className="bg-slate-900">
                                  {cleanProjectName(resolvedProjectName)}
                                </option>
                              )}
                              {projects.map((p) => (
                                <option key={p.id} value={p.id} className="bg-slate-900">
                                  {cleanProjectName(p.name)}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 font-semibold text-blue-300 text-xs">
                            <Building className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                            <span className="truncate max-w-[200px]" title={cleanProjectName(resolvedProjectName)}>
                              {cleanProjectName(resolvedProjectName)}
                            </span>
                          </div>
                        )}
                      </td>

                      {/* Assigned Hours (Inline Editable for Admins, Read-Only for Viewers) */}
                      <td className="py-3 px-3">
                        {canManageAllocations ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="number"
                              min={0.5}
                              step={0.5}
                              value={alloc.assignedHours}
                              onChange={(e) => handleInlineHoursChange(alloc.id, parseFloat(e.target.value) || 0)}
                              className="w-16 px-2 py-1 text-xs font-mono font-bold rounded bg-slate-800 border border-slate-700 text-white text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <span className="text-[10px] text-slate-400">hrs</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 font-mono text-xs font-bold text-white">
                            <span>{Number(alloc.assignedHours || 0).toFixed(1)}</span>
                            <span className="text-[10px] font-normal text-slate-400">hrs</span>
                          </div>
                        )}
                      </td>

                      {/* Logged Hours */}
                      <td className="py-3 px-3">
                        <div className="flex flex-col items-start gap-1">
                          <div className="flex items-center gap-1.5 font-mono text-xs font-semibold text-emerald-400">
                            <Clock className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                            <span>Hours Logged: {loggedHours.toFixed(1)}h</span>
                          </div>
                          {loggedHours > 0 ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                              <span>Daily Hours Logged</span>
                            </span>
                          ) : (
                            <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700/80">
                              Awaiting Daily Log
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Timeline */}
                      <td className="py-3 px-3 font-mono text-[11px] text-slate-300">
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-slate-500" />
                          <span>{alloc.startDate}</span>
                          <span className="text-slate-500 mx-1">→</span>
                          <span>{alloc.dueDate}</span>
                        </div>
                      </td>

                      {/* Action (Status Label + Delete Allocation with Confirmation Prompt for Admins) */}
                      <td className="py-3 px-3.5 text-right">
                        {canManageAllocations ? (
                          <div className="inline-flex items-center justify-end gap-2">
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30 whitespace-nowrap">
                              {badgeText}
                            </span>
                            <button
                              type="button"
                              onClick={() => setAllocationToDelete(row)}
                              className="p-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 border border-red-500/20 hover:border-red-500/40 transition inline-flex items-center justify-center shrink-0"
                              title={`Delete allocation for ${assignedName}`}
                              aria-label={`Delete allocation for ${assignedName}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30 whitespace-nowrap">
                            Work Assigned to You
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

      {/* DELETE ALLOCATION CONFIRMATION PROMPT MODAL */}
      {allocationToDelete && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full text-slate-100 shadow-2xl overflow-hidden p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 flex items-center justify-center shrink-0">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Delete Hour Allocation</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    This action removes the assignment from Firestore in real time.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAllocationToDelete(null)}
                className="p-1 text-slate-400 hover:text-white rounded-lg transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-800/70 border border-slate-700/70 text-xs space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Team Member:</span>
                <span className="font-semibold text-white">{allocationToDelete.employeeName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Project:</span>
                <span className="font-semibold text-blue-300">
                  {projects.find((p) => matchProjectId(p.id, allocationToDelete.projectId))?.name ||
                    allocationToDelete.projectName ||
                    'Unassigned Project'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Assigned Hours:</span>
                <span className="font-mono font-bold text-white">{allocationToDelete.assignedHours} hrs</span>
              </div>
            </div>

            <p className="text-xs text-slate-300">
              Are you sure you want to delete this hour allocation?
            </p>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => setAllocationToDelete(null)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleDeleteAllocation(allocationToDelete.id)}
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold transition flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete Allocation</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADD ALLOCATION MODAL */}
      {showAddModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full text-slate-100 shadow-2xl overflow-hidden my-8">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <SlidersHorizontal className="w-4 h-4 text-blue-400" />
                  Assign BIM Task & Resource Hours
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Allocate hours to team specialists with automatic capacity verification.
                </p>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                className="p-1 text-slate-400 hover:text-white rounded-lg transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddAllocation} className="p-6 space-y-4 text-xs">
              {formError && (
                <div className="p-3 bg-red-500/15 border border-red-500/30 rounded-lg text-red-300 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              {/* Project & Specialist Row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    Project
                  </label>
                  <select
                    value={formProject}
                    onChange={(e) => setFormProject(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {cleanProjectName(p.name)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    Assignee Specialist
                  </label>
                  <select
                    value={formEmployee || ''}
                    onChange={(e) => handleMemberSelect(formDiscipline, e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {activeTeamMembers.map((e) => (
                      <option key={e.id} value={e.id}>
                        {getMemberLabel(e)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Task Type */}
              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Task Type
                </label>
                <select
                  value={formTaskType}
                  onChange={(e) => setFormTaskType(e.target.value as BimTaskType)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="3D Modeling">3D Modeling</option>
                  <option value="Clash Detection">Clash Detection</option>
                  <option value="Parameter Population">Parameter Population</option>
                  <option value="2D Sheet Generation">2D Sheet Generation</option>
                  <option value="QC/QA Audit">QC/QA Audit</option>
                  <option value="COBie Data Entry">COBie Data Entry</option>
                  <option value="AI & Automation">AI & Automation</option>
                </select>
              </div>

              {/* Discipline & Phase */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    Discipline
                  </label>
                  <select
                    value={formDiscipline}
                    onChange={(e) => setFormDiscipline(e.target.value as any)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="BIM - ACS">BIM - ACS</option>
                    <option value="Structural">Structural</option>
                    <option value="MEP">MEP</option>
                    <option value="Infrastructure">Infrastructure</option>
                    <option value="Coordination & QA">Coordination & QA</option>
                    <option value="AI & Automation">AI & Automation</option>
                    <option value="Estimation">Estimation</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    Project Phase
                  </label>
                  <select
                    value={formPhase}
                    onChange={(e) => setFormPhase(e.target.value as any)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="Schematic Design">Schematic Design</option>
                    <option value="Design Development">Design Development</option>
                    <option value="Construction Documentation">Construction Documentation</option>
                    <option value="Fabrication / As-Built">Fabrication / As-Built</option>
                  </select>
                </div>
              </div>

              {/* Hours & Dates */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    Assigned Hours
                  </label>
                  <input
                    type="number"
                    min={0.5}
                    step={0.5}
                    value={formHours}
                    onChange={(e) => setFormHours(parseFloat(e.target.value) || 0)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono font-bold focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    Start Date
                  </label>
                  <input
                    type="date"
                    value={formStartDate}
                    onChange={(e) => setFormStartDate(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    Due Date
                  </label>
                  <input
                    type="date"
                    value={formDueDate}
                    onChange={(e) => setFormDueDate(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Deliverable Specifies
                </label>
                <textarea
                  rows={2}
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  placeholder="e.g. Include Navisworks clash checks and family parameter population..."
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Modal Footer */}
              <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold transition flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  <span>Allocate Hours</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
