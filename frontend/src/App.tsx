import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { LoginPage } from './auth/LoginPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { Layout } from './components/Layout';
import { ProjectsPage } from './pages/ProjectsPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { NewEstimatePage } from './pages/NewEstimatePage';
import { ImportEstimatePage } from './pages/ImportEstimatePage';
import { SuppliersPage } from './pages/SuppliersPage';
import { MaterialsPage } from './pages/MaterialsPage';
import { SpecLevelsPage } from './pages/SpecLevelsPage';
import { EquipePage } from './pages/EquipePage';

function Gate() {
  const { session, loading, activeOrg } = useAuth();
  if (loading) return <div className="auth-shell"><p className="muted">Carregando…</p></div>;
  if (!session) return <LoginPage />;
  if (!activeOrg) return <OnboardingPage />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/projetos" element={<ProjectsPage />} />
        <Route path="/novo" element={<NewEstimatePage />} />
        <Route path="/importar" element={<ImportEstimatePage />} />
        <Route path="/projetos/:id" element={<ProjectDetailPage />} />
        <Route path="/materiais" element={<MaterialsPage />} />
        <Route path="/fornecedores" element={<SuppliersPage />} />
        <Route path="/niveis" element={<SpecLevelsPage />} />
        <Route path="/equipe" element={<EquipePage />} />
        <Route path="*" element={<Navigate to="/projetos" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </AuthProvider>
  );
}
