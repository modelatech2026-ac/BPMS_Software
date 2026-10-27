import React, { useState, useEffect } from 'react';
import {
  X,
  Clock,
  Building,
  User,
  Calendar,
  CheckCircle2,
  Tag,
  FileText
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { useBimData, isUserSuperAdmin, toLocalIsoDate } from '../context/BimDataContext';
import { generateRequestDocId } from '../auth/roleSync';
import { Discipline, ActivityType, LODLevel } from '../types';

interface LogTimeModalProps {
  isOpen: boolean;
  onClose: () => void;
  preselectedProjectId?: string;
}

export const LogTimeModal: React.FC<LogTimeModalProps> = ({
  isOpen,
  onClose,
  preselectedProjectId,
}) => {
  const {
    projects,
    employees,
    resourceAllocations,
    addWorkLog,
    currentUser,
    disciplineAssignments,
    handleMemberSelect: syncDisciplineMemberToFirestore,
  } = useBimData();
  const isSuper = isUserSuperAdmin(currentUser);

  // Resolve allocations belonging to the current logged-in user
  const viewerAllocations = React.useMemo(() => {
    if (!currentUser) return [];
    const cleanEmail = (currentUser.email || '').trim().toLowerCase();
    const userId = (currentUser.id || '').trim();
    const userIdStripped = userId.replace(/^emp-/, '');
    const detId = cleanEmail ? generateRequestDocId(cleanEmail) : '';
    const userName = (currentUser.name || '').trim().toLowerCase();

    return (resourceAllocations || []).filter((alloc) => {
      const aId = (alloc.employeeId || alloc.memberId || '').trim();
      const aIdStripped = aId.replace(/^emp-/, '');
      const aEmail = (alloc.memberEmail || alloc.assignedToEmail || '').trim().toLowerCase();
      const aName = (alloc.employeeName || '').trim().toLowerCase();
      return (
        (userId && (aId === userId || aIdStripped === userIdStripped)) ||
        (detId && aIdStripped === detId) ||
        (cleanEmail && aEmail && aEmail === cleanEmail) ||
        (userName && aName && aName === userName)
      );
    });
  }, [resourceAllocations, currentUser]);

  const activeTeamMembers = React.useMemo(
    () => (employees || []).filter((member) => !member.isDeleted && member.status !== 'deleted'),
    [employees]
  );

  const [projectId, setProjectId] = useState<string>(
    preselectedProjectId || viewerAllocations[0]?.projectId || projects[0]?.id || ''
  );
  const [employeeId, setEmployeeId] = useState<string>(
    viewerAllocations[0]?.employeeId || activeTeamMembers[0]?.id || currentUser?.id || ''
  );
  const [date, setDate] = useState<string>(() => toLocalIsoDate(new Date()));
  const [hours, setHours] = useState<number>(4);
  const [discipline, setDiscipline] = useState<Discipline>('MEP - HVAC');
  const [activityType, setActivityType] = useState<ActivityType>(
    '3D Detailed Modeling'
  );
  const [taskName, setTaskName] = useState<string>('');
  const [lodStage, setLodStage] = useState<LODLevel>('LOD 350');
  const [notes, setNotes] = useState<string>('');
  const [billable, setBillable] = useState<boolean>(true);
  const [isTestEntry, setIsTestEntry] = useState<boolean>(false);

  // Sync selected project when modal opens or preselectedProjectId/projects change
  useEffect(() => {
    if (isOpen) {
      setIsTestEntry(false);
    }
    if (preselectedProjectId) {
      setProjectId(preselectedProjectId);
    } else if (isOpen && !isSuper && viewerAllocations.length > 0) {
      const hasCurrentInAssigned = viewerAllocations.some((a) => a.projectId === projectId);
      if (!hasCurrentInAssigned && viewerAllocations[0]?.projectId) {
        setProjectId(viewerAllocations[0].projectId);
      }
    } else if (!projectId && projects.length > 0) {
      setProjectId(projects[0].id);
    }
  }, [isOpen, preselectedProjectId, projects, projectId, isSuper, viewerAllocations]);

  // Auto-select current logged in user or hydrated discipline assignee when modal opens
  const wasOpenRef = React.useRef(false);
  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;

    if (currentUser?.email) {
      const cleanEmail = currentUser.email.trim().toLowerCase();
      const detId = generateRequestDocId(cleanEmail);
      const match = employees.find(
        (e) =>
          e.id === currentUser.id ||
          e.id.replace(/^emp-/, '') === (currentUser.id || '').replace(/^emp-/, '') ||
          e.id.replace(/^emp-/, '') === detId ||
          (e.email && e.email.trim().toLowerCase() === cleanEmail) ||
          (e.name && currentUser.name && e.name.trim().toLowerCase() === currentUser.name.trim().toLowerCase())
      );
      const allocMatch = viewerAllocations[0];

      if (!isSuper) {
        if (allocMatch?.employeeId) {
          setEmployeeId(allocMatch.employeeId);
        } else if (match) {
          setEmployeeId(match.id);
        } else if (currentUser.id) {
          setEmployeeId(currentUser.id);
        } else {
          setEmployeeId(`emp-${detId}`);
        }
        return;
      }

      const hydratedAssignee =
        disciplineAssignments[`${projectId}__${discipline}`] ||
        disciplineAssignments[discipline];
      if (hydratedAssignee && employees.some((e) => e.id === hydratedAssignee)) {
        setEmployeeId(hydratedAssignee);
        return;
      }

      if (match) {
        setEmployeeId(match.id);
      } else if (employees.length > 0) {
        setEmployeeId(employees[0].id);
      } else if (currentUser.id) {
        setEmployeeId(currentUser.id);
      } else {
        setEmployeeId(`emp-${detId}`);
      }
    } else if (employees.length > 0 && !employeeId) {
      setEmployeeId(employees[0].id);
    }
  }, [isOpen, currentUser, employees, disciplineAssignments, projectId, discipline, employeeId, isSuper, viewerAllocations]);

  // Hydrate dropdown value from real-time onSnapshot disciplineAssignments when updated externally (Super Admin only)
  useEffect(() => {
    if (!isSuper) return;
    if (employeeId && !activeTeamMembers.some((e) => e.id === employeeId)) {
      if (activeTeamMembers.length > 0) {
        setEmployeeId(activeTeamMembers[0].id);
      }
      return;
    }
    const syncedMemberId =
      disciplineAssignments[`${projectId}__${discipline}`] ||
      disciplineAssignments[discipline];
    if (syncedMemberId && syncedMemberId !== employeeId && activeTeamMembers.some((e) => e.id === syncedMemberId)) {
      setEmployeeId(syncedMemberId);
    }
  }, [disciplineAssignments, projectId, discipline, isSuper, activeTeamMembers, employeeId]);

  const selectedProject = projects.find((p) => p.id === projectId) || projects[0];
  const assignedMemberId =
    employeeId ||
    (isSuper
      ? disciplineAssignments[`${projectId}__${discipline}`] ||
        disciplineAssignments[discipline] ||
        ''
      : viewerAllocations[0]?.employeeId || currentUser?.id || '');
  const selectedEmployee = employees.find((e) => e.id === assignedMemberId);

  const handleMemberSelect = async (disciplineKey: string, memberId: string) => {
    setEmployeeId(memberId);
    const chosenEmp = employees.find((e) => e.id === memberId);
    const resolvedDiscipline = (chosenEmp?.discipline || chosenEmp?.primaryDiscipline || disciplineKey || discipline) as Discipline;
    if (chosenEmp?.discipline || chosenEmp?.primaryDiscipline) {
      setDiscipline(resolvedDiscipline);
    }
    try {
      await syncDisciplineMemberToFirestore(resolvedDiscipline, memberId, projectId);
    } catch (err) {
      console.warn('Error syncing member selection to Firestore:', err);
    }
  };

  // Auto-fill task if project has tasks or matching assignment
  useEffect(() => {
    const matchedAllocForProj = viewerAllocations.find((a) => a.projectId === projectId);
    if (matchedAllocForProj) {
      setDiscipline((matchedAllocForProj.discipline as Discipline) || 'BIM - ACS');
      setLodStage((matchedAllocForProj.lod as LODLevel) || 'LOD 350');
      if (!taskName) {
        setTaskName(matchedAllocForProj.taskType || `${matchedAllocForProj.discipline} Modeling Task`);
      }
      return;
    }
    if (selectedProject?.tasks && selectedProject.tasks.length > 0 && selectedProject.tasks[0]) {
      setTaskName(selectedProject.tasks[0].name || '');
      setDiscipline(selectedProject.tasks[0].discipline || 'MEP - HVAC');
      setLodStage(selectedProject.tasks[0].lod || 'LOD 350');
    }
  }, [projectId, selectedProject, viewerAllocations]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const resolvedProjectId = projectId || viewerAllocations[0]?.projectId || projects[0]?.id || '';
    if (!resolvedProjectId || hours <= 0) return;

    const cleanCurrentEmail = (currentUser?.email || '').trim().toLowerCase();
    const fallbackUserId =
      currentUser?.id || (cleanCurrentEmail ? `emp-${generateRequestDocId(cleanCurrentEmail)}` : 'emp-user');
    const effectiveEmployeeId = assignedMemberId || fallbackUserId;

    const selectedEmp = employees.find(
      (emp) =>
        emp.id === effectiveEmployeeId ||
        emp.id.replace(/^emp-/, '') === effectiveEmployeeId.replace(/^emp-/, '')
    );
    const isLoggingForSelf =
      !isSuper ||
      !selectedEmp ||
      selectedEmp.id === currentUser?.id ||
      (selectedEmp.email && cleanCurrentEmail && selectedEmp.email.trim().toLowerCase() === cleanCurrentEmail);

    // Match against active assignments in resourceAllocations so log.employeeId === assignment.memberId and log.projectId === assignment.projectId
    const matchedAssignment = (resourceAllocations || []).find((alloc) => {
      const sameProj =
        alloc.projectId === resolvedProjectId ||
        alloc.projectId.replace(/^p(\d+)$/, 'proj-$1') === resolvedProjectId.replace(/^p(\d+)$/, 'proj-$1');
      if (!sameProj) return false;
      const aId = (alloc.employeeId || alloc.memberId || '').trim();
      const aIdStripped = aId.replace(/^emp-/, '');
      const effIdStripped = effectiveEmployeeId.replace(/^emp-/, '');
      const aEmail = (alloc.memberEmail || alloc.assignedToEmail || '').trim().toLowerCase();
      const targetEmail = (selectedEmp?.email || (isLoggingForSelf ? cleanCurrentEmail : '')).trim().toLowerCase();
      const aName = (alloc.employeeName || '').trim().toLowerCase();
      const targetName = (selectedEmp?.name || (isLoggingForSelf ? currentUser?.name : '') || '').trim().toLowerCase();
      return (
        aId === effectiveEmployeeId ||
        (aIdStripped && aIdStripped === effIdStripped) ||
        (targetEmail && aEmail && aEmail === targetEmail) ||
        (targetName && aName && aName === targetName)
      );
    });

    const finalEmpId =
      matchedAssignment?.memberId ||
      matchedAssignment?.employeeId ||
      selectedEmp?.id ||
      effectiveEmployeeId;
    const finalProjectId = matchedAssignment?.projectId || resolvedProjectId;
    const finalEmpName =
      matchedAssignment?.employeeName ||
      selectedEmp?.name ||
      (isLoggingForSelf ? currentUser?.name : undefined) ||
      currentUser?.name ||
      (cleanCurrentEmail ? cleanCurrentEmail.split('@')[0] : 'BIM Modeler');
    const memberEmail = (
      matchedAssignment?.memberEmail ||
      selectedEmp?.email ||
      (isLoggingForSelf ? cleanCurrentEmail : '') ||
      cleanCurrentEmail ||
      ''
    )
      .trim()
      .toLowerCase();
    const resolvedUserId =
      (isLoggingForSelf && currentUser?.id) ||
      (memberEmail ? generateRequestDocId(memberEmail) : '') ||
      finalEmpId.replace(/^emp-/, '');

    const loggedByIdentifier =
      cleanCurrentEmail ||
      currentUser?.name ||
      memberEmail ||
      finalEmpName ||
      'BIM Modeler';
    const createdAtIso = new Date().toISOString();

    addWorkLog({
      employeeId: finalEmpId,
      memberId: finalEmpId,
      employeeName: finalEmpName,
      projectId: finalProjectId,
      projectName: matchedAssignment?.projectName || selectedProject?.name || 'BIM Project',
      date,
      hoursLogged: Number(hours),
      discipline,
      activityType,
      taskName: taskName || `${discipline} Modeling Task`,
      lodStage,
      notes: notes || `Logged ${hours}h on ${activityType} for ${selectedProject?.name || 'BIM Project'}`,
      billable,
      memberEmail,
      userEmail: memberEmail,
      userId: resolvedUserId,
      isTestEntry: Boolean(isTestEntry),
      loggedBy: loggedByIdentifier,
      createdAt: createdAtIso,
    });

    try {
      confetti({
        particleCount: 35,
        spread: 50,
        origin: { y: 0.8 },
      });
    } catch {}

    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full my-8 text-slate-100 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 text-blue-400 flex items-center justify-center">
              <Clock className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">
                Log Daily Project Hours
              </h3>
              <p className="text-xs text-slate-400">
                Record BIM modeler time against project WBS and LOD stages
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-slate-400 font-medium mb-1">
                BIM Specialist / Modeler
              </label>
              <select
                aria-label="Select Modeler"
                value={assignedMemberId || ''}
                onChange={(e) => handleMemberSelect(discipline, e.target.value)}
                className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
                required
              >
                {activeTeamMembers.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name} ({emp.role})
                  </option>
                ))}
                {currentUser &&
                  !activeTeamMembers.some(
                    (e) =>
                      e.id === currentUser.id ||
                      (e.email &&
                        currentUser.email &&
                        e.email.trim().toLowerCase() === currentUser.email.trim().toLowerCase())
                  ) && (
                    <option
                      value={
                        selectedEmployee?.id ||
                        currentUser.id ||
                        (currentUser.email ? `emp-${generateRequestDocId(currentUser.email)}` : 'emp-user')
                      }
                    >
                      {currentUser.name || currentUser.email} ({currentUser.role || 'Member'})
                    </option>
                  )}
              </select>
            </div>

            <div>
              <label className="block text-slate-400 font-medium mb-1">
                Target Project
              </label>
              <select
                aria-label="Select Target Project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
                required
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-slate-400 font-medium mb-1">
                Log Date
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-slate-400 font-medium mb-1">
                Hours Spent
              </label>
              <input
                type="number"
                step="0.5"
                min="0.5"
                max="24"
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
                className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 font-bold"
                required
              />
            </div>

            <div>
              <label className="block text-slate-400 font-medium mb-1">
                LOD Level
              </label>
              <select
                aria-label="Select LOD Level"
                value={lodStage}
                onChange={(e) => setLodStage(e.target.value as LODLevel)}
                className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
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
              <label className="block text-slate-400 font-medium mb-1">
                BIM Discipline
              </label>
              <select
                aria-label="Select BIM Discipline"
                value={discipline}
                onChange={(e) => setDiscipline(e.target.value as Discipline)}
                className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
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
              <label className="block text-slate-400 font-medium mb-1">
                Activity Category
              </label>
              <select
                aria-label="Select Activity Category"
                value={activityType}
                onChange={(e) => setActivityType(e.target.value as ActivityType)}
                className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
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
            <label className="block text-slate-400 font-medium mb-1">
              Work Notes & Technical Details
            </label>
            <textarea
              rows={3}
              placeholder="Detailed description of coordination adjustments, clashes resolved, or sheets compiled..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full bg-slate-800 text-slate-200 rounded-lg p-2 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 leading-relaxed"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="billable"
                checked={billable}
                onChange={(e) => setBillable(e.target.checked)}
                className="rounded bg-slate-800 border-slate-700 text-blue-600 focus:ring-blue-500"
              />
              <label htmlFor="billable" className="text-slate-300 select-none cursor-pointer">
                Billable Client Project Hours
              </label>
            </div>

            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30">
              <input
                type="checkbox"
                id="isTestEntry"
                checked={isTestEntry}
                onChange={(e) => setIsTestEntry(e.target.checked)}
                className="rounded bg-slate-800 border-amber-500/50 text-amber-500 focus:ring-amber-500"
              />
              <label htmlFor="isTestEntry" className="text-amber-300 font-semibold select-none cursor-pointer flex items-center gap-1.5">
                <span>Mark as Test Entry</span>
                {isTestEntry && (
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
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold transition flex items-center gap-1.5"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Submit Timesheet Entry</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
