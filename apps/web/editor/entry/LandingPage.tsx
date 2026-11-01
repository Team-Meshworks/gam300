import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowRight,
  faPlay,
  faMap,
  faUsers,
  faLayerGroup,
  faBookOpen,
  faFileLines,
  faCircleXmark,
  faCircleCheck,
  faCalendarDays,
  faEye,
  faCommentDots,
  faStar,
  faHouse,
  faCompass,
  faWandMagicSparkles,
} from "@fortawesome/free-solid-svg-icons";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { EntryBrand } from "./EntryBrand";
import hero from "./assets/hero.png";
import history from "./assets/gallery-history.png";
import science from "./assets/gallery-science.png";
import culture from "./assets/gallery-culture.png";

const steps = [
  {
    icon: faFileLines,
    tag: "Teachers",
    title: "Assign guided projects",
    body: "Set clear instructions, due dates, and learning objectives so students know exactly what to build before they begin.",
  },
  {
    icon: faCircleXmark,
    tag: "Students",
    title: "Build interactive exhibits",
    body: "Students curate 3D artifacts, write exhibit labels, and arrange immersive spaces that bring history, culture, and science to life.",
  },
  {
    icon: faCircleCheck,
    tag: "Class review",
    title: "Review and discuss together",
    body: "Teachers review student work, leave feedback, and compare submissions in one shared workspace designed for classroom discussion.",
  },
];
const features = [
  {
    icon: faLayerGroup,
    title: "3D asset library",
    body: "Start with historical objects, architectural fragments, and cultural artifacts that students can arrange into meaningful exhibits.",
  },
  {
    icon: faBookOpen,
    title: "Guided project templates",
    body: "Use structured prompts and rubrics to help students organize research, curation, and presentation in one clear workflow.",
  },
  {
    icon: faUsers,
    title: "Class review workspace",
    body: "Teachers can review student work, compare submissions, and facilitate peer feedback without leaving the platform.",
  },
  {
    icon: faCalendarDays,
    title: "Due dates and instructions",
    body: "Keep expectations clear with assignable prompts, deadlines, and submission expectations that students can follow from start to finish.",
  },
  {
    icon: faEye,
    title: "Immersive preview",
    body: "Preview student museums as interactive 3D spaces before they are shared, making it easier to review pacing, labels, and exhibit flow.",
  },
  {
    icon: faCommentDots,
    title: "Feedback and discussion",
    body: "Support peer review, teacher feedback, and classroom discussion around the work students are building together.",
  },
];
const exhibits = [
  {
    image: history,
    icon: faMap,
    category: "History",
    title: "The Silk Road: Trade and exchange",
    body: "Students curated artifacts, routes, and trade stories into an immersive gallery that feels like a real museum walkthrough.",
  },
  {
    image: science,
    icon: faStar,
    category: "Science",
    title: "Ancient astronomy: Observatories and instruments",
    body: "This exhibit pairs 3D models with interactive labels and historical context, making complex science feel approachable and immersive.",
  },
  {
    image: culture,
    icon: faHouse,
    category: "Culture",
    title: "Cultural heritage: Textiles, pottery, and daily life",
    body: "Students arranged artifacts into a spatial narrative that helps visitors understand how objects were used, valued, and passed down.",
  },
];

export function LandingPage() {
  const [preview, setPreview] = useState<(typeof exhibits)[number] | null>(null);
  const [help, setHelp] = useState(false);
  return (
    <div className="entry-page landing-page">
      <a className="sp-skip-link" href="#main">
        Skip to content
      </a>
      <main id="main" tabIndex={-1}>
        <section className="landing-hero" id="overview">
          <header className="entry-header">
            <EntryBrand />
            <nav aria-label="Main navigation">
              <a href="#platform">Platform</a>
              <a href="#teachers">For teachers</a>
              <a href="#gallery">Gallery</a>
              <a href="#resources">Resources</a>
            </nav>
            <a className="entry-cta" href="/login">
              Get Started <FontAwesomeIcon icon={faArrowRight} aria-hidden="true" />
            </a>
          </header>
          <div className="landing-hero-content">
            <div className="landing-hero-copy">
              <span className="entry-pill">
                <FontAwesomeIcon icon={faWandMagicSparkles} aria-hidden="true" />
                Student-led interactive museums
              </span>
              <h1>Build immersive history, culture, and science spaces with your class.</h1>
              <p>
                SPATIA helps students curate interactive 3D exhibits, teachers assign guided
                projects, and classrooms review work together in one shared learning environment.
              </p>
              <div className="entry-actions">
                <a className="entry-cta" href="/login">
                  Start a classroom <FontAwesomeIcon icon={faArrowRight} aria-hidden="true" />
                </a>
                <button
                  className="entry-cta entry-cta--light"
                  disabled
                  title="Walkthrough coming soon"
                >
                  <FontAwesomeIcon icon={faPlay} aria-hidden="true" />
                  Watch the walkthrough
                </button>
              </div>
            </div>
            <div className="landing-hero-visual">
              <img src={hero} alt="An immersive museum with ancient artifacts" />
              <div className="landing-hero-overlay">
                <div className="entry-between">
                  <strong>
                    <FontAwesomeIcon icon={faMap} aria-hidden="true" /> Student project
                  </strong>
                  <span className="entry-pill">
                    <FontAwesomeIcon icon={faUsers} aria-hidden="true" />
                    Class gallery
                  </span>
                </div>
                <h2>The Silk Road: Curated artifacts and immersive exhibits</h2>
                <p>
                  Students build interactive galleries with 3D objects, guided prompts, and peer
                  review. Teachers assign the project, set due dates, and review work in one shared
                  workspace.
                </p>
                <div className="entry-actions">
                  <span className="entry-pill">
                    <FontAwesomeIcon icon={faLayerGroup} aria-hidden="true" />
                    3D artifacts
                  </span>
                  <span className="entry-pill">
                    <FontAwesomeIcon icon={faBookOpen} aria-hidden="true" />
                    Guided prompts
                  </span>
                  <span className="entry-pill">
                    <FontAwesomeIcon icon={faUsers} aria-hidden="true" />
                    Class review
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section className="landing-section" id="teachers">
          <div className="landing-section-heading">
            <p className="entry-eyebrow">How it works</p>
            <h2>A complete workflow for student creators and classroom facilitators</h2>
            <p>
              SPATIA connects project setup, student creation, and review into one cohesive learning
              flow.
            </p>
          </div>
          <div className="landing-card-grid">
            {steps.map((step) => (
              <article className="landing-card" key={step.title}>
                <div className="entry-between">
                  <span className="entry-feature-icon">
                    <FontAwesomeIcon icon={step.icon} aria-hidden="true" />
                  </span>
                  <span className="entry-pill">{step.tag}</span>
                </div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="landing-section landing-features" id="platform">
          <div className="landing-section-heading">
            <p className="entry-eyebrow">Core features</p>
            <h2>Everything classrooms need to build, share, and review immersive spaces</h2>
          </div>
          <div className="landing-card-grid">
            {features.map((feature) => (
              <article className="landing-card" key={feature.title}>
                <span className="entry-feature-icon">
                  <FontAwesomeIcon icon={feature.icon} aria-hidden="true" />
                </span>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="landing-section" id="gallery">
          <div className="landing-section-heading">
            <p className="entry-eyebrow">Student gallery</p>
            <h2>Explore the kinds of immersive spaces students can build</h2>
            <p>
              From historical trade routes to cultural heritage sites, SPATIA helps students turn
              research into interactive, shareable exhibits.
            </p>
          </div>
          <div className="landing-card-grid">
            {exhibits.map((exhibit) => (
              <article className="landing-card landing-exhibit" key={exhibit.title}>
                <div className="landing-exhibit-image">
                  <img
                    src={exhibit.image}
                    alt={`${exhibit.category} museum concept`}
                    loading="lazy"
                  />
                  <span className="entry-pill">
                    <FontAwesomeIcon icon={exhibit.icon} aria-hidden="true" />
                    {exhibit.category}
                  </span>
                </div>
                <h3>{exhibit.title}</h3>
                <p>{exhibit.body}</p>
                <div className="entry-between">
                  <strong>Design example</strong>
                  <Button onClick={() => setPreview(exhibit)}>
                    <FontAwesomeIcon icon={faEye} aria-hidden="true" /> Preview exhibit
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>
        <section className="landing-section landing-callout">
          <div className="landing-section-heading">
            <p className="entry-eyebrow">Ready to get started?</p>
            <h2>Bring immersive learning into your classroom</h2>
            <p>
              Create a classroom, assign a guided project, and help students build interactive
              exhibits that make history, culture, and science feel real.
            </p>
          </div>
          <div className="entry-actions">
            <a className="entry-cta" href="/login">
              Start a classroom <FontAwesomeIcon icon={faArrowRight} aria-hidden="true" />
            </a>
            <button className="entry-cta entry-cta--light" disabled title="Walkthrough coming soon">
              <FontAwesomeIcon icon={faPlay} aria-hidden="true" />
              Watch the walkthrough
            </button>
          </div>
          <div className="entry-actions">
            {features.slice(0, 3).map((feature) => (
              <span className="entry-pill" key={feature.title}>
                <FontAwesomeIcon icon={feature.icon} aria-hidden="true" />
                {feature.title}
              </span>
            ))}
          </div>
        </section>
      </main>
      <footer className="landing-footer" id="resources">
        <div className="landing-footer-columns">
          <div className="landing-footer-brand">
            <a href="/landing">
              <span>
                <FontAwesomeIcon icon={faCompass} aria-hidden="true" />
              </span>
              SPATIA
            </a>
            <p>
              SPATIA is an educational platform for building interactive virtual museums, immersive
              spaces, and guided classroom projects.
            </p>
          </div>
          <div>
            <h3>Product</h3>
            <a href="#overview">Overview</a>
            <a href="#platform">Features</a>
            <a href="#gallery">Gallery</a>
            <button onClick={() => setHelp(true)}>Resources</button>
          </div>
          <div>
            <h3>Classroom</h3>
            <a href="#teachers">For teachers</a>
            <a href="#teachers">For students</a>
            <a href="/login">Review workspace</a>
            <a href="#platform">Project templates</a>
          </div>
          <div>
            <h3>Company</h3>
            <a href="#overview">About</a>
            <button onClick={() => setHelp(true)}>Contact</button>
            <button onClick={() => setHelp(true)}>Support</button>
          </div>
        </div>
        <div className="entry-footer">
          <p>© 2026 SPATIA. All rights reserved.</p>
          <div>
            <button disabled title="Not published yet">
              Privacy
            </button>
            <button disabled title="Not published yet">
              Terms
            </button>
          </div>
        </div>
      </footer>
      {preview && (
        <Dialog title={preview.title} onClose={() => setPreview(null)}>
          <img
            className="entry-exhibit-preview"
            src={preview.image}
            alt={`${preview.category} museum concept`}
          />
          <p>{preview.body}</p>
          <p className="sp-hint">
            Design example. A published interactive exhibit is not connected yet.
          </p>
        </Dialog>
      )}
      {help && (
        <Dialog title="Classroom support" onClose={() => setHelp(false)}>
          <p>
            Contact your teacher or organisation administrator for an account, password reset, or
            classroom guidance.
          </p>
        </Dialog>
      )}
    </div>
  );
}
