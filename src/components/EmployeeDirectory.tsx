import React, { useState, useMemo } from 'react';
import {
  Users,
  Clock,
  Building,
  Mail,
  Plus,
  Search,
  TrendingUp,
  Award,
  Edit,
  Star,
  AlertTriangle,
  CheckCircle2,
  Gauge,
} from 'lucide-react';
import { useBimData, isUserSuperAdmin } from '../context/BimDataContext';
import { Employee, BimProject, PRIMARY_DISCIPLINES } from '../types';
import { EditEmployeeModal } from './EditEmployeeModal';

interface EmployeeDirectoryProps {
  onOpenNewEmployeeModal: () => void;
  onOpenLogModalForEmployee?: (empId: string) => void;
  onSelectProject?: (project: BimProject) => void;
}

export type EfficiencyTier = 'Poor' | 'Average' | 'Good' | 'Star';

export const getEfficiencyTier = (efficiencyPct: number): EfficiencyTier => {
  const normalized = Number(efficiencyPct.toFixed(1));
  if (normalized === 50 || Math.round(efficiencyPct) === 50) {
    return 'Average';
  }
  if (normalized < 50) {
    return 'Poor';
  }
  if (normalized > 50 && normalized <= 80) {
    return 'Good';
  }
  return 'Star';
};

const matchProjectId = (idA?: string, idB?: string): boolean => {
  if (!idA || !idB) return false;
  if (idA === idB) return true;
  const normA = idA.startsWith('proj-') ? idA : idA.replace(/^p(\d+)$/, 'proj-$1');
  const normB = idB.startsWith('proj-') ? idB : idB.replace(/^p(\d+)$/, 'proj-$1');
  return normA === normB;
};

interface EfficiencyMatrixRow {
  rowKey: string;
  employeeId: string;
  employeeName: string;
  employeeRole: string;
  employeeEmail: string;
  discipline: string;
  employeeObj?: Employee;
  projectIds: string[];
  loggedHours: number;
  assignedHours: number;
  varianceHours: number;
  efficiencyPct: number;
  tier: EfficiencyTier;
}

export const EmployeeDirectory: React.FC<EmployeeDirectoryProps> = ({
  onOpenNewEmployeeModal,
}) => {
  const {
    employees,
    workLogs,
    allWorkLogs,
    resourceAllocations,
    projects,
    theme,
    currentUser,
  } = useBimData();
  const isLight = theme === 'light';
  const isSuperAdmin = isUserSuperAdmin(currentUser);

  const activeWorkLogs = allWorkLogs && allWorkLogs.length > 0 ? allWorkLogs : workLogs;

  const [searchTerm, setSearchTerm] = useState('');
  const [disciplineFilter, setDisciplineFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');
  const [tierFilter, setTierFilter] = useState<'all' | EfficiencyTier>('all');
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);

  // Build real-time consolidated efficiency rows per team member from assigned_hours (resourceAllocations), daily_logs (activeWorkLogs), and employees
  const efficiencyRows = useMemo<EfficiencyMatrixRow[]>(() => {
    const memberMap = new Map<
      string,
      {
        employeeId: string;
        employeeName: string;
        employeeRole: string;
        employeeEmail: string;
        discipline: string;
        employeeObj?: Employee;
        projectIds: Set<string>;
        assignedHours: number;
        hasExplicitAllocation: boolean;
      }
    >();

    const activeEmployees = (employees || []).filter(
      (e) => !e.isDeleted && e.status !== 'deleted'
    );

    const resolveEmployee = (empId?: string, email?: string, name?: string): Employee | undefined => {
      const cleanId = (empId || '').trim();
      const strippedId = cleanId.replace(/^emp-/, '');
      const cleanEmail = (email || '').trim().toLowerCase();
      const cleanName = (name || '').trim().toLowerCase();

      return activeEmployees.find((e) => {
        const eIdStripped = (e.id || '').replace(/^emp-/, '');
        const eEmail = (e.email || '').trim().toLowerCase();
        const eName = (e.name || '').trim().toLowerCase();
        return (
          (cleanId && (e.id === cleanId || (strippedId && eIdStripped === strippedId))) ||
          (cleanEmail && eEmail === cleanEmail) ||
          (cleanName && eName === cleanName)
        );
      });
    };

    const resolveProject = (projId?: string, projName?: string): BimProject | undefined => {
      return (projects || []).find(
        (p) =>
          matchProjectId(p.id, projId) ||
          (projName && p.name.trim().toLowerCase() === projName.trim().toLowerCase())
      );
    };

    const findExistingMemberKey = (emp?: Employee, rawId?: string, rawEmail?: string, rawName?: string): string => {
      const targetId = (emp?.id || rawId || '').trim();
      const targetStripped = targetId.replace(/^emp-/, '').toLowerCase();
      const targetEmail = (emp?.email || rawEmail || '').trim().toLowerCase();
      const targetName = (emp?.name || rawName || '').trim().toLowerCase();

      for (const [key, entry] of memberMap.entries()) {
        const entryIdStripped = (entry.employeeId || '').replace(/^emp-/, '').toLowerCase();
        const entryEmail = (entry.employeeEmail || '').trim().toLowerCase();
        const entryName = (entry.employeeName || '').trim().toLowerCase();
        if (
          (targetStripped && entryIdStripped && targetStripped === entryIdStripped) ||
          (targetEmail && entryEmail && targetEmail === entryEmail) ||
          (targetName && entryName && targetName === entryName)
        ) {
          return key;
        }
      }

      if (emp?.id) return emp.id;
      if (targetEmail) return targetEmail;
      if (targetStripped) return targetStripped;
      return targetName || `member-${memberMap.size}`;
    };

    // 1. Seed all active registered employees so every team member appears at most once
    activeEmployees.forEach((emp) => {
      const empKey = findExistingMemberKey(emp, emp.id, emp.email, emp.name);
      if (!memberMap.has(empKey)) {
        memberMap.set(empKey, {
          employeeId: emp.id,
          employeeName: emp.name,
          employeeRole: emp.role,
          employeeEmail: emp.email,
          discipline: emp.primaryDiscipline || emp.discipline || 'BIM - ACS',
          employeeObj: emp,
          projectIds: new Set(emp.activeProjectIds || []),
          assignedHours: 0,
          hasExplicitAllocation: false,
        });
      }
    });

    // 2. Aggregate all real-time allocations from assigned_hours / project_assignments per member
    (resourceAllocations || []).forEach((alloc) => {
      const proj = resolveProject(alloc.projectId, alloc.projectName);
      const resolvedProjId = proj?.id || alloc.projectId || '';
      if (projectFilter !== 'all' && !matchProjectId(resolvedProjId, projectFilter)) {
        return;
      }

      const emp = resolveEmployee(
        alloc.employeeId || alloc.memberId || alloc.assignedTo,
        alloc.memberEmail || alloc.assignedToEmail,
        alloc.employeeName || alloc.assignedToName || alloc.memberName
      );
      const empKey = findExistingMemberKey(
        emp,
        alloc.employeeId || alloc.memberId || alloc.assignedTo,
        alloc.memberEmail || alloc.assignedToEmail,
        alloc.employeeName || alloc.assignedToName || alloc.memberName
      );

      const existing = memberMap.get(empKey);
      if (existing) {
        existing.assignedHours += Number(alloc.assignedHours) || 0;
        existing.hasExplicitAllocation = true;
        if (resolvedProjId) existing.projectIds.add(resolvedProjId);
      } else {
        memberMap.set(empKey, {
          employeeId: emp?.id || alloc.employeeId || empKey,
          employeeName: emp?.name || alloc.employeeName || alloc.assignedToName || 'BIM Specialist',
          employeeRole: emp?.role || alloc.employeeRole || 'BIM Modeler',
          employeeEmail: emp?.email || alloc.memberEmail || alloc.assignedToEmail || '',
          discipline: emp?.primaryDiscipline || alloc.discipline || 'BIM - ACS',
          employeeObj: emp,
          projectIds: new Set(resolvedProjId ? [resolvedProjId] : []),
          assignedHours: Number(alloc.assignedHours) || 0,
          hasExplicitAllocation: true,
        });
      }
    });

    // 3. Ensure any daily_logs / work_logs entries also sync to the member's consolidated row
    (activeWorkLogs || []).forEach((log) => {
      if (log.isTestEntry) return;
      const proj = resolveProject(log.projectId, log.projectName);
      const resolvedProjId = proj?.id || log.projectId || '';
      if (projectFilter !== 'all' && !matchProjectId(resolvedProjId, projectFilter)) {
        return;
      }

      const emp = resolveEmployee(log.employeeId, log.memberEmail || (log as any).userEmail, log.employeeName);
      const empKey = findExistingMemberKey(
        emp,
        log.employeeId,
        log.memberEmail || (log as any).userEmail,
        log.employeeName
      );

      const existing = memberMap.get(empKey);
      if (existing) {
        if (resolvedProjId) existing.projectIds.add(resolvedProjId);
      } else {
        memberMap.set(empKey, {
          employeeId: emp?.id || log.employeeId || empKey,
          employeeName: emp?.name || log.employeeName || 'BIM Specialist',
          employeeRole: emp?.role || 'BIM Modeler',
          employeeEmail: emp?.email || log.memberEmail || (log as any).userEmail || '',
          discipline: emp?.primaryDiscipline || log.discipline || 'BIM - ACS',
          employeeObj: emp,
          projectIds: new Set(resolvedProjId ? [resolvedProjId] : []),
          assignedHours: 0,
          hasExplicitAllocation: false,
        });
      }
    });

    // 4. Compute consolidated logged hours, assigned hours, variance, efficiency %, and tier once per member
    const rows: EfficiencyMatrixRow[] = [];

    memberMap.forEach((item, rowKey) => {
      const loggedHours = (activeWorkLogs || [])
        .filter((w) => {
          if (w.isTestEntry) return false;
          if (projectFilter !== 'all' && !matchProjectId(w.projectId, projectFilter)) {
            return false;
          }

          const itemEmpIdStripped = (item.employeeId || '').replace(/^emp-/, '').toLowerCase();
          const wEmpIdStripped = (w.employeeId || '').replace(/^emp-/, '').toLowerCase();
          const matchId =
            Boolean(item.employeeId) &&
            (w.employeeId === item.employeeId ||
              (itemEmpIdStripped && wEmpIdStripped === itemEmpIdStripped));
          const matchEmail =
            Boolean(item.employeeEmail) &&
            ((w.memberEmail || (w as any).userEmail || '').trim().toLowerCase() ===
              item.employeeEmail.trim().toLowerCase());
          const matchName =
            Boolean(item.employeeName) &&
            (w.employeeName || '').trim().toLowerCase() ===
              item.employeeName.trim().toLowerCase();

          return matchId || matchEmail || matchName;
        })
        .reduce((sum, w) => sum + (Number(w.hoursLogged) || 0), 0);

      if (
        projectFilter !== 'all' &&
        !item.hasExplicitAllocation &&
        loggedHours === 0 &&
        !Array.from(item.projectIds).some((pid) => matchProjectId(pid, projectFilter))
      ) {
        return;
      }

      const fallbackCapacity = item.employeeObj?.weeklyCapacityHours || 40;
      const assignedHours = item.hasExplicitAllocation
        ? Number(item.assignedHours) || 0
        : fallbackCapacity;
      const varianceHours = Number((loggedHours - assignedHours).toFixed(1));
      const efficiencyPct =
        assignedHours > 0 ? Number(((loggedHours / assignedHours) * 100).toFixed(1)) : 0;
      const tier = getEfficiencyTier(efficiencyPct);

      rows.push({
        rowKey,
        employeeId: item.employeeId,
        employeeName: item.employeeName,
        employeeRole: item.employeeRole,
        employeeEmail: item.employeeEmail,
        discipline: item.discipline,
        employeeObj: item.employeeObj,
        projectIds: Array.from(item.projectIds),
        loggedHours: Number(loggedHours.toFixed(1)),
        assignedHours: Number(assignedHours.toFixed(1)),
        varianceHours,
        efficiencyPct,
        tier,
      });
    });

    return rows;
  }, [employees, resourceAllocations, activeWorkLogs, projects, projectFilter]);

  const filteredRows = useMemo(() => {
    return efficiencyRows.filter((row) => {
      const q = searchTerm.trim().toLowerCase();
      const matchesSearch =
        !q ||
        row.employeeName.toLowerCase().includes(q) ||
        row.employeeRole.toLowerCase().includes(q) ||
        row.employeeEmail.toLowerCase().includes(q) ||
        row.discipline.toLowerCase().includes(q) ||
        row.tier.toLowerCase().includes(q);

      const matchesDiscipline =
        disciplineFilter === 'all' || row.discipline === disciplineFilter;

      const matchesTier = tierFilter === 'all' || row.tier === tierFilter;

      return matchesSearch && matchesDiscipline && matchesTier;
    });
  }, [efficiencyRows, searchTerm, disciplineFilter, tierFilter]);

  const summaryStats = useMemo(() => {
    const totalLogged = filteredRows.reduce((s, r) => s + r.loggedHours, 0);
    const totalAssigned = filteredRows.reduce((s, r) => s + r.assignedHours, 0);
    const overallEfficiency =
      totalAssigned > 0 ? Number(((totalLogged / totalAssigned) * 100).toFixed(1)) : 0;

    return {
      totalLogged: Number(totalLogged.toFixed(1)),
      totalAssigned: Number(totalAssigned.toFixed(1)),
      overallEfficiency,
      overallTier: getEfficiencyTier(overallEfficiency),
      starCount: filteredRows.filter((r) => r.tier === 'Star').length,
      goodCount: filteredRows.filter((r) => r.tier === 'Good').length,
      averageCount: filteredRows.filter((r) => r.tier === 'Average').length,
      poorCount: filteredRows.filter((r) => r.tier === 'Poor').length,
    };
  }, [filteredRows]);

  const getTierBadgeStyle = (tier: EfficiencyTier) => {
    switch (tier) {
      case 'Star':
        return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
      case 'Good':
        return 'bg-blue-500/20 text-blue-300 border-blue-500/40';
      case 'Average':
        return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
      case 'Poor':
        return 'bg-rose-500/20 text-rose-300 border-rose-500/40';
    }
  };

  const getTierBarColor = (tier: EfficiencyTier) => {
    switch (tier) {
      case 'Star':
        return 'bg-emerald-500';
      case 'Good':
        return 'bg-blue-500';
      case 'Average':
        return 'bg-amber-500';
      case 'Poor':
        return 'bg-rose-500';
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div
        className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 border rounded-xl p-5 shadow-xs transition-colors ${
          isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
        }`}
      >
        <div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-400 flex items-center justify-center border border-blue-500/20">
              <Gauge className="w-4 h-4" />
            </div>
            <h2
              className={`text-xl font-bold tracking-tight ${
                isLight ? 'text-slate-900' : 'text-white'
              }`}
            >
              Team Efficiency
            </h2>
            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30">
              Real-Time Performance Matrix
            </span>
          </div>
          <p className={`text-xs mt-1 ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
            Live bi-directional synchronization between Assigned Hours and Daily Hour Logs with tiered efficiency classification.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Tier Thresholds Legend */}
          <div className="hidden xl:flex items-center gap-1.5 text-[11px] bg-slate-800/80 border border-slate-700/80 rounded-lg px-3 py-1.5">
            <span className="text-slate-400 font-semibold mr-1">Tiers:</span>
            <span className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 font-medium">
              0–&lt;50%: Poor
            </span>
            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-medium">
              50%: Average
            </span>
            <span className="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30 font-medium">
              &gt;50–80%: Good
            </span>
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-medium">
              &gt;80%: Star
            </span>
          </div>

          {isSuperAdmin && (
            <button
              onClick={onOpenNewEmployeeModal}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition shadow-sm"
            >
              <Plus className="w-4 h-4" />
              <span>Add Member</span>
            </button>
          )}
        </div>
      </div>

      {/* Tier Summary KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div
          className={`border rounded-xl p-4 shadow-xs ${
            isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Overall Efficiency
            </span>
            <TrendingUp className="w-4 h-4 text-blue-400" />
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-2xl font-bold text-white font-mono">
              {summaryStats.overallEfficiency.toFixed(1)}%
            </span>
            <span
              className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${getTierBadgeStyle(
                summaryStats.overallTier
              )}`}
            >
              {summaryStats.overallTier === 'Star' ? '★ Star' : summaryStats.overallTier}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1 font-mono">
            {summaryStats.totalLogged}h Logged / {summaryStats.totalAssigned}h Assigned
          </p>
        </div>

        <div
          className={`border rounded-xl p-4 shadow-xs ${
            isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Star Tier (&gt;80%)
            </span>
            <Star className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-emerald-400 font-mono">
              {summaryStats.starCount}
            </span>
            <span className="text-xs text-slate-400">Members</span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">Above 80% target efficiency</p>
        </div>

        <div
          className={`border rounded-xl p-4 shadow-xs ${
            isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Good & Average (50%–80%)
            </span>
            <CheckCircle2 className="w-4 h-4 text-blue-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-blue-400 font-mono">
              {summaryStats.goodCount + summaryStats.averageCount}
            </span>
            <span className="text-xs text-slate-400">
              ({summaryStats.goodCount} Good • {summaryStats.averageCount} Average)
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">50% Average | &gt;50% to 80% Good</p>
        </div>

        <div
          className={`border rounded-xl p-4 shadow-xs ${
            isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Poor Tier (0%–50%)
            </span>
            <AlertTriangle className="w-4 h-4 text-rose-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-rose-400 font-mono">
              {summaryStats.poorCount}
            </span>
            <span className="text-xs text-slate-400">Members</span>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">Below 50% logged vs assigned threshold</p>
        </div>
      </div>

      {/* Search & Filters */}
      <div
        className={`flex flex-col lg:flex-row items-center justify-between gap-3 border p-3.5 rounded-xl transition-colors ${
          isLight ? 'bg-white border-slate-200' : 'bg-slate-900/80 border-slate-800'
        }`}
      >
        <div className="flex items-center gap-2 w-full lg:w-80 relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search team member, role, tier..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className={`w-full text-xs rounded-lg pl-9 pr-3 py-2 border focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              isLight
                ? 'bg-slate-50 text-slate-900 border-slate-300 placeholder-slate-400'
                : 'bg-slate-800 text-slate-200 border-slate-700 placeholder-slate-500'
            }`}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2.5 w-full lg:w-auto justify-end text-xs">
          {/* Project Filter */}
          <select
            aria-label="Filter by project"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className={`text-xs rounded-lg px-3 py-2 border focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer ${
              isLight
                ? 'bg-slate-50 text-slate-900 border-slate-300'
                : 'bg-slate-800 text-slate-200 border-slate-700'
            }`}
          >
            <option value="all">All Projects ({projects.length})</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {/* Discipline Filter */}
          <select
            aria-label="Filter specialists by discipline"
            value={disciplineFilter}
            onChange={(e) => setDisciplineFilter(e.target.value)}
            className={`text-xs rounded-lg px-3 py-2 border focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer ${
              isLight
                ? 'bg-slate-50 text-slate-900 border-slate-300'
                : 'bg-slate-800 text-slate-200 border-slate-700'
            }`}
          >
            <option value="all">All Primary Disciplines</option>
            {PRIMARY_DISCIPLINES.map((discipline) => (
              <option key={discipline} value={discipline}>
                {discipline}
              </option>
            ))}
          </select>

          {/* Efficiency Tier Filter */}
          <select
            aria-label="Filter by efficiency tier"
            value={tierFilter}
            onChange={(e) => setTierFilter(e.target.value as 'all' | EfficiencyTier)}
            className={`text-xs rounded-lg px-3 py-2 border focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer ${
              isLight
                ? 'bg-slate-50 text-slate-900 border-slate-300'
                : 'bg-slate-800 text-slate-200 border-slate-700'
            }`}
          >
            <option value="all">All Efficiency Tiers</option>
            <option value="Star">Star (&gt;80%)</option>
            <option value="Good">Good (&gt;50% to 80%)</option>
            <option value="Average">Average (50%)</option>
            <option value="Poor">Poor (0% to 50%)</option>
          </select>

          {(searchTerm || disciplineFilter !== 'all' || projectFilter !== 'all' || tierFilter !== 'all') && (
            <button
              onClick={() => {
                setSearchTerm('');
                setDisciplineFilter('all');
                setProjectFilter('all');
                setTierFilter('all');
              }}
              className="px-2.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Consolidated Team Efficiency Table */}
      <div
        className={`rounded-xl border overflow-hidden shadow-sm ${
          isLight ? 'bg-white border-slate-200' : 'bg-slate-900 border-slate-800'
        }`}
      >
        <div className="overflow-x-auto">
          <table className="w-full table-auto border-collapse text-left text-xs text-slate-300">
            <thead className="bg-slate-800/90 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-700 text-[11px]">
              <tr>
                <th className="w-[38%] min-w-[240px] py-3.5 px-5 whitespace-nowrap align-middle">
                  TEAM MANAGEMENT
                </th>
                <th className="w-[34%] min-w-[280px] py-3.5 px-5 whitespace-normal break-words leading-relaxed align-middle">
                  LOGGED HOURS - ASSIGNED HOURS
                </th>
                <th className="w-[28%] min-w-[220px] py-3.5 px-5 whitespace-nowrap align-middle">
                  EFFICIENCY (%)
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-14 text-center text-slate-500">
                    <Users className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                    <p className="text-sm font-semibold text-slate-400">
                      No team efficiency records match the active filters.
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      Allocate hours in Assigned Hours System or log daily hours to populate real-time metrics.
                    </p>
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => {
                  const initials =
                    (row.employeeName || 'U')
                      .split(' ')
                      .map((n) => n[0])
                      .slice(0, 2)
                      .join('')
                      .toUpperCase() || 'U';

                  return (
                    <tr key={row.rowKey} className="hover:bg-slate-800/40 transition">
                      {/* Column 1: TEAM MANAGEMENT */}
                      <td className="py-3.5 px-5 align-middle">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center font-bold text-white text-xs shrink-0 shadow-xs">
                              {initials}
                            </div>
                            <div className="min-w-0">
                              <div className="font-bold text-white text-[13px] truncate flex items-center gap-1.5">
                                <span>{row.employeeName}</span>
                                {row.tier === 'Star' && (
                                  <span
                                    className="text-emerald-400 text-xs"
                                    title="Star Efficiency (>80%)"
                                  >
                                    ★
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-blue-400 font-medium truncate">
                                {row.employeeRole} • {row.discipline}
                              </div>
                              {row.employeeEmail && (
                                <div className="text-[10px] text-slate-500 truncate flex items-center gap-1 mt-0.5">
                                  <Mail className="w-2.5 h-2.5 shrink-0" />
                                  <span className="truncate">{row.employeeEmail}</span>
                                </div>
                              )}
                            </div>
                          </div>

                          {isSuperAdmin && row.employeeObj && (
                            <button
                              type="button"
                              onClick={() => setEditingEmployee(row.employeeObj!)}
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-blue-400 border border-slate-700 transition shrink-0"
                              title={`Edit ${row.employeeName}`}
                            >
                              <Edit className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>

                      {/* Column 2: LOGGED HOURS - ASSIGNED HOURS */}
                      <td className="py-3.5 px-5 align-middle">
                        <div className="flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                            <span className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-bold whitespace-nowrap">
                              {row.loggedHours.toFixed(1)}h Logged
                            </span>
                            <span className="text-slate-500 font-bold">−</span>
                            <span className="px-2 py-0.5 rounded bg-blue-500/10 border border-blue-500/30 text-blue-300 font-bold whitespace-nowrap">
                              {row.assignedHours.toFixed(1)}h Assigned
                            </span>
                          </div>
                          <div className="text-[10px] font-mono text-slate-400 flex items-center gap-1.5">
                            <Clock className="w-3 h-3 text-slate-500" />
                            <span>
                              Remaining:{' '}
                              <strong
                                className={
                                  row.assignedHours - row.loggedHours < 0
                                    ? 'text-rose-400'
                                    : 'text-slate-300'
                                }
                              >
                                {Math.max(0, Number((row.assignedHours - row.loggedHours).toFixed(1)))}h
                              </strong>
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Column 3: EFFICIENCY (%) */}
                      <td className="py-3.5 px-5 align-middle">
                        <div className="space-y-1.5 max-w-[240px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-sm font-bold text-white">
                              {row.efficiencyPct.toFixed(1)}%
                            </span>
                            <span
                              className={`inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-0.5 rounded-full border ${getTierBadgeStyle(
                                row.tier
                              )}`}
                            >
                              {row.tier === 'Star' && <span>★</span>}
                              <span>{row.tier}</span>
                            </span>
                          </div>
                          <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${getTierBarColor(
                                row.tier
                              )}`}
                              style={{
                                width: `${Math.min(100, Math.max(0, row.efficiencyPct))}%`,
                              }}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Employee Modal */}
      {isSuperAdmin && (
        <EditEmployeeModal
          isOpen={Boolean(editingEmployee)}
          onClose={() => setEditingEmployee(null)}
          employee={editingEmployee}
        />
      )}
    </div>
  );
};
