import React, { useState } from "react";
import "./ClassSchedule.css";

const days = [
  { date: "22", day: "Sat" },
  { date: "23", day: "Sun" },
  { date: "24", day: "Mon" },
  { date: "25", day: "Tue" },
  { date: "26", day: "Wed" },
  { date: "27", day: "Thu" },
];

const classes = [
  {
    start: "08:30",
    end: "10:00",
    title: "Software Quality Assurance",
    course: "CSE442",
    section: "CSE442(64_M)",
    teacher: "FFZ",
    room: "KT-501(B) (COM LAB)",
  },
  {
    start: "10:00",
    end: "11:30",
    title: "UI and UX Design",
    course: "CSE441",
    section: "CSE441(64_M)",
    teacher: "SMF",
    room: "KT-513 (COM LAB)",
  },
];

export default function ClassSchedule() {
  const [selectedDay, setSelectedDay] = useState("23");

  return (
    <div className="schedule">
      <div className="day-picker">
        {days.map((item) => (
          <button
            key={item.date}
            className={`day-card ${selectedDay === item.date ? "active" : ""}`}
            onClick={() => setSelectedDay(item.date)}
          >
            <span className="date">{item.date}</span>
            <span className="weekday">{item.day}</span>
          </button>
        ))}
      </div>

      <div className="timeline">
        {classes.map((item) => (
          <div className="class-row" key={item.course}>
            <div className="time">
              <span>{item.start}</span>
              <div className="time-lines">
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
              <span>{item.end}</span>
            </div>

            <div className="class-card">
              <h3>{item.title}</h3>

              <div className="info-row">
                <span>Course</span>
                <strong>{item.course}</strong>
              </div>

              <div className="info-row">
                <span>Section</span>
                <strong>{item.section}</strong>
              </div>

              <div className="info-row">
                <span>Teacher</span>
                <strong className="teacher">{item.teacher}</strong>
              </div>

              <div className="info-row">
                <span>Room</span>
                <strong>{item.room}</strong>
              </div>
            </div>
          </div>
        ))}

        <div className="break-card">
          <div>
            <div className="break-title">Break Time</div>
            <div className="break-time">11:30 - 01:00 (1h 30m)</div>
          </div>
          <div className="coffee">☕</div>
        </div>
      </div>
    </div>
  );
}
