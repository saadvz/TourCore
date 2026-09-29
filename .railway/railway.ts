import { defineRailway, github, project, service, volume } from "railway/iac";

/**
 * Distributor configuration for the one demo Railway service.
 * Landlords do not create a Railway project. This file has no secrets and
 * no generated domain: Railway assigns RAILWAY_PUBLIC_DOMAIN when a public
 * domain is generated. Apply with `railway config plan` then
 * `railway config apply`. GitHub pushes deploy the connected branch; they
 * do not apply this file by themselves.
 *
 * Config-as-code railway.json is not used. New Railway services cannot opt
 * into it, and it stops being read on 2026-12-01.
 */
export default defineRailway(() => {
  const data = volume("tourcore-data", { sizeMB: 1024 });
  const web = service("tour-core", {
    source: github("saadvz/TourCore", { branch: "master" }),
    build: "npm run build",
    start: "npm start",
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    replicas: 1,
    volumeMounts: { "/data": data },
    env: {
      TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0",
      TOURCORE_HOME: "/data",
      NODE_ENV: "production",
    },
  });
  return project("tour-core", { resources: [web, data] });
});
