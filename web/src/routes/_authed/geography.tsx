import { createFileRoute } from "@tanstack/react-router";
import { GeographyPage } from "../../geography/GeographyPage";
import { validateGeographySearch } from "../../geography/search";

export const Route=createFileRoute("/_authed/geography")({validateSearch:validateGeographySearch,component:GeographyPage});
