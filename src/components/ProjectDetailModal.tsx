import React, { useState, useEffect } from 'react';
import {
  X,
  Clock,
  Layers,
  Calendar,
  Building,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Users,
  Plus,
  ArrowRight,
  TrendingUp,
  ShieldCheck,
  Edit3,
  Check
} from 'lucide-react';
import { useBimData, isUserSuperAdmin } from '../context/BimDataContext';
import { BimProject, Milestone, TaskItem, LODLevel } from '../types';
import { calculateDeliveryVariance, getProjectStatusStyle } from '../utils/deliveryVariance';

interface ProjectDetailModalProps {
  project: BimProject | null;
  onClose: () => void;
  onOpenReportModalWithProject: (projectId: string) => void;
  onOpenLogModalWithProject: (projectId: string) => void;
}

export const ProjectDetailModal: React.FC<ProjectDetailModalProps> = ({
  project,
  onClose,
  onOpenReportModalWithProject,
  onOpenLogModalWithProject,
}) => {
  const {
    projects,
    getProjectCompletedHours,
    employees,
    updateMilestoneStatus,
    updateTask,
    addTask,
    addMilestone,
    updateProject,
    updateProjectStatus,
    currentUser,
    disciplineAssignments,
    handleMemberSelect: syncDisciplineMemberToFirestore,
  } = useBimData();

  const liveProject = projects.find((p) => p.id === project?.id) || project;

  const isSuperAdmin = isUserSuperAdmin(currentUser);
  const [activeTab, setActiveTab] = useState<'overview' | 'tasks' | 'milestones' | 'clashes'>('overview');
  const [showAddTask, setShowAddTask] = useState(false);
  const [isEditingDeliveryDates, setIsEditingDeliveryDates] = useState(false);
  const [newPlannedDateValue, setNewPlannedDateValue] = useState('');
  const [newActualDateValue, setNewActualDateValue] = useState('');

  // New task form
  const [taskName, setTaskName] = useState('');
  const [taskDiscipline, setTaskDiscipline] = useState(liveProject?.disciplines?.[0] || 'BIM - ACS');
  const [taskLOD, setTaskLOD] = useState<LODLevel>('LOD 350');
  const [taskEstHours, setTaskEstHours] = useState(80);
  const [taskAssignee, setTaskAssignee] = useState(employees[0]?.id || '');
  const [taskDueDate, setTaskDueDate] = useState('2026-09-30');

  useEffect(() => {
    if (liveProject?.disciplines && liveProject.disciplines.length > 0) {
      setTaskDiscipline(liveProject.disciplines[0]);
    }
  }, [liveProject?.id]);

  if (!liveProject) return null;

  const handleMemberSelect = async (
    disciplineKey: string,
    memberId: string,
    taskId?: string
  ) => {
    if (taskId) {
      updateTask(liveProject.id, taskId, {
        assignedEmployeeId: memberId,
        discipline: disciplineKey as any,
      });
    } else {
      setTaskAssignee(memberId);
    }
    try {
      await syncDisciplineMemberToFirestore(disciplineKey, memberId, liveProject.id);
    } catch (err) {
      console.warn('Firestore discipline assignment sync notice:', err);
    }
  };

  const completedHours = getProjectCompletedHours(liveProject.id);
  const variance = liveProject.totalEstimatedHours - completedHours;
  const isOverBudget = completedHours > liveProject.totalEstimatedHours;
  const burnPct = liveProject.totalEstimatedHours > 0
    ? Math.min(100, Math.round((completedHours / liveProject.totalEstimatedHours) * 100))
    : 0;

  const assignedStaff = employees.filter((e) =>
    liveProject.assignedEmployeeIds.includes(e.id)
  );

  const handleCreateTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskName) return;

    addTask(project.id, {
      name: taskName,
      discipline: taskDiscipline as any,
      lod: taskLOD,
      estimatedHours: Number(taskEstHours),
      completedHours: 0,
      status: 'In Progress',
      assignedEmployeeId: taskAssignee,
      dueDate: taskDueDate,
    });

    setTaskName('');
    setShowAddTask(false);
  };

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-4xl w-full my-8 text-slate-100 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-start justify-between bg-slate-900">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-blue-400 font-mono">{project.code}</span>
              {isSuperAdmin ? (
                <div className="relative inline-block">
                  <select
                    value={project.status}
                    onChange={(e) => updateProjectStatus(project.id, e.target.value as any)}
                    className={`font-semibold text-[11px] px-2.5 py-0.5 rounded-full border cursor-pointer focus:outline-none transition ${getProjectStatusStyle(
                      project.status
                    )}`}
                  >
                    <option value="WIP" className="bg-slate-900 text-cyan-300">WIP</option>
                    <option value="On Track" className="bg-slate-900 text-emerald-300">On Track</option>
                    <option value="At Risk" className="bg-slate-900 text-amber-300">At Risk</option>
                    <option value="HOLD" className="bg-slate-900 text-orange-300">HOLD</option>
                    <option value="CLOSED" className="bg-slate-900 text-slate-300">CLOSED</option>
                    <option value="Completed" className="bg-slate-900 text-emerald-300">Completed</option>
                  </select>
                </div>
              ) : (
                <span
                  className={`font-semibold text-[11px] px-2.5 py-0.5 rounded-full border ${getProjectStatusStyle(
                    project.status
                  )}`}
                >
                  {project.status}
                </span>
              )}
            </div>
            <h2 className="text-lg font-bold text-white mt-1">{project.name}</h2>
            <p className="text-xs text-slate-400">
              {project.clientName} • {project.buildingType} • {project.location}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onOpenLogModalWithProject(project.id)}
              className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition flex items-center gap-1"
            >
              <Clock className="w-3.5 h-3.5" />
              <span>Log Hours</span>
            </button>
            <button
              onClick={() => onOpenReportModalWithProject(project.id)}
              className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-xs font-medium transition flex items-center gap-1"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-300" />
              <span>AI Report</span>
            </button>
            <button
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-white rounded-lg transition ml-2"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="px-6 border-b border-slate-800 bg-slate-900/50 flex space-x-4 text-xs font-medium">
          {[
            { id: 'overview', label: 'Project Overview & Hours' },
            { id: 'tasks', label: `WBS Tasks (${project.tasks.length})` },
            { id: 'milestones', label: `LOD Milestones (${project.milestones.length})` },
            { id: 'clashes', label: `Clash Register (${project.clashes.length})` },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`py-3 border-b-2 transition ${
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-400 font-bold'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Hours Summary Box */}
              <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-5 text-xs space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-slate-400 font-semibold uppercase">Estimated vs Actual Hours Burn</span>
                    <h3 className="text-lg font-bold text-white mt-0.5">
                      {completedHours} / {project.totalEstimatedHours} hrs
                    </h3>
                  </div>
                  <div className="text-right">
                    <span className={`text-xl font-bold ${isOverBudget ? 'text-amber-400' : 'text-blue-400'}`}>
                      {burnPct}%
                    </span>
                    <p className="text-[11px] text-slate-400">Total Hours Allocated</p>
                  </div>
                </div>

                <div className="w-full bg-slate-700 h-3 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      isOverBudget ? 'bg-amber-500' : 'bg-blue-500'
                    }`}
                    style={{ width: `${burnPct}%` }}
                  />
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-slate-700 text-xs">
                  <div>
                    <span className="text-slate-400 block">Estimated Budget:</span>
                    <strong className="text-white text-sm">${project.budgetAmount.toLocaleString()}</strong>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Hours Variance:</span>
                    <strong className={`text-sm ${isOverBudget ? 'text-amber-400' : 'text-emerald-400'}`}>
                      {isOverBudget ? `+${completedHours - project.totalEstimatedHours}h Over` : `${variance}h Remaining`}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Current LOD:</span>
                    <strong className="text-indigo-400 text-sm">{project.currentLOD}</strong>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Target LOD:</span>
                    <strong className="text-slate-200 text-sm">{project.targetLOD}</strong>
                  </div>
                </div>
              </div>

              {/* Delivery Dates & Variance Tracker */}
              {(() => {
                const plannedDate = liveProject.plannedDeliveryDate || liveProject.targetCompletionDate;
                const actualDate = liveProject.actualDeliveredDate;
                const varianceInfo = calculateDeliveryVariance(plannedDate, actualDate, liveProject.status);
                return (
                  <div className="bg-slate-800/50 border border-slate-700/60 rounded-xl p-4 text-xs space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5 text-blue-400" />
                        Delivery Schedule & Variance
                      </h4>
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${varianceInfo.badgeClass}`}>
                        {varianceInfo.label}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1 text-slate-300">
                      <div className="p-2.5 bg-slate-900/60 rounded-lg border border-slate-800 flex items-center justify-between gap-2">
                        <div>
                          <span className="text-slate-400 text-[11px] block">Planned Delivery Date:</span>
                          <strong className="text-white text-xs">{plannedDate || 'Not specified'}</strong>
                        </div>
                        {isSuperAdmin && (
                          <button
                            type="button"
                            onClick={() => {
                              setNewPlannedDateValue(plannedDate || '');
                              setNewActualDateValue(actualDate || '');
                              setIsEditingDeliveryDates(true);
                            }}
                            className="p-1.5 rounded-lg hover:bg-slate-800 text-amber-400 hover:text-amber-300 transition shrink-0"
                            title="Edit Planned Delivery Date (Super Admin Override)"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="p-2.5 bg-slate-900/60 rounded-lg border border-slate-800 flex items-center justify-between gap-2">
                        <div>
                          <span className="text-slate-400 text-[11px] block">Actual Delivered Date:</span>
                          <strong className={actualDate ? 'text-emerald-400 text-xs' : 'text-slate-500 text-xs'}>
                            {actualDate || 'In Progress'}
                          </strong>
                        </div>
                        {isSuperAdmin && (
                          <button
                            type="button"
                            onClick={() => {
                              setNewPlannedDateValue(plannedDate || '');
                              setNewActualDateValue(actualDate || '');
                              setIsEditingDeliveryDates(true);
                            }}
                            className="p-1.5 rounded-lg hover:bg-slate-800 text-amber-400 hover:text-amber-300 transition shrink-0"
                            title="Edit Actual Delivered Date (Super Admin Override)"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="p-2.5 bg-slate-900/60 rounded-lg border border-slate-800">
                        <span className="text-slate-400 text-[11px] block">Schedule Status:</span>
                        <strong className="text-xs text-indigo-300">{varianceInfo.subText}</strong>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Project Description */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                  BIM Scope & Engineering Strategy
                </h4>
                <p className="text-xs text-slate-300 leading-relaxed bg-slate-800/40 p-4 rounded-xl border border-slate-700/50">
                  {project.description}
                </p>
              </div>

              {/* Disciplines Engaged */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                  Active BIM Disciplines
                </h4>
                <div className="flex flex-wrap gap-2">
                  {liveProject.disciplines.map((disc) => {
                    const assignedMemberId =
                      disciplineAssignments[`${liveProject.id}__${disc}`] ||
                      disciplineAssignments[disc] ||
                      liveProject.tasks.find((t) => t.discipline === disc)?.assignedEmployeeId ||
                      '';
                    return (
                      <div
                        key={disc}
                        className="px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs font-medium flex items-center gap-2"
                      >
                        <span>{disc}</span>
                        {isSuperAdmin && employees.length > 0 && (
                          <select
                            aria-label={`Assign specialist for ${disc}`}
                            value={assignedMemberId || ''}
                            onChange={(e) => handleMemberSelect(disc, e.target.value)}
                            className="bg-slate-900 text-slate-200 text-[11px] rounded px-1.5 py-0.5 border border-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
                          >
                            <option value="">Unassigned</option>
                            {employees.map((emp) => (
                              <option key={emp.id} value={emp.id}>
                                {emp.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Assigned Specialists */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                  Engaged BIM Team ({assignedStaff.length})
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {assignedStaff.map((emp) => (
                    <div
                      key={emp.id}
                      className="p-3 rounded-lg bg-slate-800/50 border border-slate-700/50 flex items-center gap-2.5 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-bold text-white truncate">{emp.name}</div>
                        <div className="text-[11px] text-slate-400">{emp.role}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Tasks Tab */}
          {activeTab === 'tasks' && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                  Work Breakdown Tasks & Estimated Hours
                </h4>
                {isSuperAdmin && (
                  <button
                    onClick={() => setShowAddTask(true)}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Task</span>
                  </button>
                )}
              </div>

              <div className="space-y-3">
                {liveProject.tasks.map((task) => {
                  const assignedMemberId =
                    task.assignedEmployeeId ||
                    disciplineAssignments[`${liveProject.id}__${task.discipline}`] ||
                    disciplineAssignments[task.discipline] ||
                    '';
                  const assignee = employees.find((e) => e.id === assignedMemberId);
                  const isTaskOver = task.completedHours > task.estimatedHours;
                  const taskPct = task.estimatedHours > 0
                    ? Math.min(100, Math.round((task.completedHours / task.estimatedHours) * 100))
                    : 0;

                  return (
                    <div
                      key={task.id}
                      className="p-3.5 rounded-xl bg-slate-800/50 border border-slate-700/60 text-xs space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-white">{task.name}</span>
                            <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] font-semibold border border-slate-700">
                              {task.discipline}
                            </span>
                            <span className="text-indigo-400 font-bold text-[10px]">
                              {task.lod}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                            <span>Assigned:</span>
                            {isSuperAdmin && employees.length > 0 ? (
                              <select
                                aria-label={`Assign team member for ${task.name}`}
                                value={assignedMemberId || ''}
                                onChange={(e) =>
                                  handleMemberSelect(task.discipline, e.target.value, task.id)
                                }
                                className="bg-slate-800 text-slate-200 text-[11px] font-semibold rounded px-1.5 py-0.5 border border-slate-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500"
                              >
                                <option value="">Unassigned</option>
                                {employees.map((emp) => (
                                  <option key={emp.id} value={emp.id}>
                                    {emp.name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <strong className="text-slate-300">{assignee?.name || 'Unassigned'}</strong>
                            )}
                            <span>• Due: {task.dueDate}</span>
                          </div>
                        </div>

                        {isSuperAdmin ? (
                          <select
                            aria-label="Change task status"
                            value={task.status}
                            onChange={(e) =>
                              updateTask(liveProject.id, task.id, {
                                status: e.target.value as TaskItem['status'],
                              })
                            }
                            className="bg-slate-800 text-slate-200 text-xs rounded px-2 py-1 border border-slate-700 cursor-pointer"
                          >
                            <option value="Not Started">Not Started</option>
                            <option value="In Progress">In Progress</option>
                            <option value="Under Review">Under Review</option>
                            <option value="Completed">Completed</option>
                          </select>
                        ) : (
                          <span className="px-2.5 py-1 rounded bg-slate-800 text-slate-300 text-[11px] font-medium border border-slate-700">
                            {task.status}
                          </span>
                        )}
                      </div>

                      <div className="flex justify-between items-center text-[11px] text-slate-400">
                        <span>
                          Hours: <strong className="text-blue-400">{task.completedHours}h</strong> / {task.estimatedHours}h
                        </span>
                        <span className={isTaskOver ? 'text-amber-400 font-semibold' : 'text-slate-300'}>
                          {taskPct}% {isTaskOver && '(Over Budget)'}
                        </span>
                      </div>
                      <div className="w-full bg-slate-700 h-1.5 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${isTaskOver ? 'bg-amber-500' : 'bg-blue-500'}`}
                          style={{ width: `${taskPct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Add Task Form modal/inline */}
              {showAddTask && (
                <form
                  onSubmit={handleCreateTask}
                  className="bg-slate-800/90 border border-slate-700 p-4 rounded-xl text-xs space-y-3"
                >
                  <h5 className="font-bold text-white">Create New WBS Task</h5>
                  <div>
                    <label className="block text-slate-400 mb-1">Task Title</label>
                    <input
                      type="text"
                      value={taskName}
                      onChange={(e) => setTaskName(e.target.value)}
                      placeholder="e.g., Level 2 Electrical Cable Tray Modeling LOD 350"
                      className="w-full bg-slate-800 text-slate-200 rounded p-2 border border-slate-700"
                      required
                    />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-slate-400 mb-1">Discipline</label>
                      <select
                        aria-label="Select Task Discipline"
                        value={taskDiscipline}
                        onChange={(e) => setTaskDiscipline(e.target.value as any)}
                        className="w-full bg-slate-800 text-slate-200 rounded p-1.5 border border-slate-700"
                      >
                        {Array.from(new Set([...project.disciplines, 'AI & Automation'])).map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">LOD Stage</label>
                      <select
                        aria-label="Select LOD Stage"
                        value={taskLOD}
                        onChange={(e) => setTaskLOD(e.target.value as any)}
                        className="w-full bg-slate-800 text-slate-200 rounded p-1.5 border border-slate-700"
                      >
                        <option value="LOD 200">LOD 200</option>
                        <option value="LOD 300">LOD 300</option>
                        <option value="LOD 350">LOD 350</option>
                        <option value="LOD 400">LOD 400</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Est. Hours</label>
                      <input
                        type="number"
                        value={taskEstHours}
                        onChange={(e) => setTaskEstHours(Number(e.target.value))}
                        className="w-full bg-slate-800 text-slate-200 rounded p-1.5 border border-slate-700"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Assignee</label>
                      <select
                        aria-label="Select Task Assignee"
                        value={taskAssignee || ''}
                        onChange={(e) => handleMemberSelect(taskDiscipline, e.target.value)}
                        className="w-full bg-slate-800 text-slate-200 rounded p-1.5 border border-slate-700"
                      >
                        {employees.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowAddTask(false)}
                      className="px-3 py-1.5 rounded bg-slate-800 text-slate-300"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="px-4 py-1.5 rounded bg-blue-600 text-white font-semibold"
                    >
                      Save Task
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* Milestones Tab */}
          {activeTab === 'milestones' && (
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                BIM LOD Deliverable Milestones
              </h4>
              <div className="space-y-3">
                {project.milestones.map((ms) => (
                  <div
                    key={ms.id}
                    className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/60 text-xs space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <h5 className="font-bold text-white text-sm">{ms.title}</h5>
                          <span className="text-indigo-400 font-bold text-[10px] px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/30">
                            {ms.lodRequirement}
                          </span>
                        </div>
                        <p className="text-slate-400 mt-1 leading-relaxed">
                          {ms.deliverableDescription}
                        </p>
                      </div>
                      {isSuperAdmin ? (
                        <select
                          aria-label="Change milestone status"
                          value={ms.status}
                          onChange={(e) =>
                            updateMilestoneStatus(
                              project.id,
                              ms.id,
                              e.target.value as Milestone['status']
                            )
                          }
                          className="bg-slate-800 text-slate-200 text-xs rounded px-2.5 py-1 border border-slate-700 cursor-pointer"
                        >
                          <option value="upcoming">Upcoming</option>
                          <option value="in-progress">In Progress</option>
                          <option value="completed">Completed</option>
                          <option value="delayed">Delayed</option>
                        </select>
                      ) : (
                        <span className="px-2.5 py-1 rounded bg-slate-800 text-slate-300 text-[11px] font-medium border border-slate-700 capitalize">
                          {ms.status}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-[11px] text-slate-400 pt-1 border-t border-slate-700/60">
                      <span>Target Date: <strong className="text-slate-200">{ms.targetDate}</strong></span>
                      {ms.completionDate && (
                        <span className="text-emerald-400">
                          Completed on: {ms.completionDate}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Clashes Tab */}
          {activeTab === 'clashes' && (
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                Cross-Trade Coordination Clashes ({project.clashes.length})
              </h4>
              <div className="space-y-3">
                {project.clashes.map((c) => (
                  <div
                    key={c.id}
                    className="p-3.5 rounded-xl bg-slate-800/50 border border-slate-700/60 text-xs space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            c.severity === 'Critical'
                              ? 'bg-rose-500/20 text-rose-400'
                              : 'bg-amber-500/20 text-amber-400'
                          }`}
                        >
                          {c.severity}
                        </span>
                        <span className="font-bold text-slate-200">
                          {c.disciplineA} &times; {c.disciplineB}
                        </span>
                      </div>
                      <span className="text-slate-400 text-[11px]">{c.status}</span>
                    </div>
                    <div className="text-white font-medium">{c.elementRef}</div>
                    <div className="text-slate-400 text-[11px]">{c.locationDescription}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Super Admin Date Override Modal */}
      {isEditingDeliveryDates && isSuperAdmin && (
        <div
          className="fixed inset-0 bg-slate-950/80 backdrop-blur-xs z-[60] flex items-center justify-center p-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 text-slate-100 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-white">Super Admin Date Override</h3>
                  <p className="text-[11px] text-slate-400">Lock protected field</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsEditingDeliveryDates(false)}
                className="p-1 text-slate-400 hover:text-white rounded-lg transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <span className="text-slate-400 block text-[11px]">Target Project:</span>
                <strong className="text-white font-semibold text-xs">{liveProject.name}</strong>
              </div>

              <div>
                <label className="text-slate-300 font-semibold block text-[11px] mb-1">
                  Planned Delivery Date:
                </label>
                <input
                  type="text"
                  placeholder="e.g. 18-08-2026 or 2026-08-18"
                  value={newPlannedDateValue}
                  onChange={(e) => setNewPlannedDateValue(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono focus:outline-none focus:ring-2 focus:ring-amber-500 text-xs"
                />
              </div>

              <div>
                <label className="text-slate-300 font-semibold block text-[11px] mb-1">
                  Actual Delivered Date (DD-MM-YYYY or YYYY-MM-DD) *
                </label>
                <input
                  type="text"
                  placeholder="e.g. 18-08-2026 or 2026-08-18"
                  value={newActualDateValue}
                  onChange={(e) => setNewActualDateValue(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono focus:outline-none focus:ring-2 focus:ring-amber-500 text-xs"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Leave empty to mark as WIP/In-Progress without delivery timestamp.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => setIsEditingDeliveryDates(false)}
                className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const trimmedPlanned = newPlannedDateValue.trim();
                  const trimmedActual = newActualDateValue.trim();
                  updateProject(liveProject.id, {
                    plannedDeliveryDate: trimmedPlanned,
                    targetCompletionDate: trimmedPlanned,
                    actualDeliveredDate: trimmedActual || undefined,
                  });
                  setIsEditingDeliveryDates(false);
                }}
                className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold transition flex items-center gap-1.5"
              >
                <Check className="w-3.5 h-3.5" />
                <span>Save Date</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
