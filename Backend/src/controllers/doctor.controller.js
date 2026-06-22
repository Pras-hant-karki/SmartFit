import { asyncHandler } from "../utils/asynchandler.js";
import { Doctor } from "../models/doctor.model.js";
import { apiError } from "../utils/apiError.js";
import { uploadLocal } from "../utils/localUpload.js";
import { apiResponse } from "../utils/apiResponse.js";
import jwt from "jsonwebtoken"
import sendMail from "../services/mail.js";
import { welcomeemailtemplate, logintemplate } from "../utils/emailtemplate.js";
import path from "path";

const sendDoctorMail = async (mailOptions) => {
    try {
        await sendMail(mailOptions);
    } catch (error) {
        console.error("Doctor email notification failed:", error.message);
    }
};

const isProduction = process.env.NODE_ENV === "production";

const generateaccesstokenandrefreshtoken = async (patientId) => {
    try {
        const doctor = await Doctor.findById(patientId);
        const accesstoken = await doctor.generateaccesstoken();
        const refreshtoken = await doctor.generaterefreshtoken();

        if (!accesstoken) {
            throw new apiError(500, "Access token generation failed");
        }

        if (!refreshtoken) {
            throw new apiError(500, "Refresh token generation failed");
        }

        doctor.refreshtoken = refreshtoken;
        await doctor.save({ validateBeforeSave: false });

        return { accesstoken, refreshtoken };

    } catch (error) {
        console.error("Token generation failed:", error);
        throw error;
    }
};

const parseShiftArray = (shift) => {
    if (!shift) return [];
    let parsedShift;
    try {
        parsedShift = Array.isArray(shift) ? shift : JSON.parse(shift);
    } catch {
        throw new apiError(400, "Invalid format for 'shift'. Must be a valid JSON array.")
    }
    if (!Array.isArray(parsedShift)) {
        throw new apiError(400, "Invalid format for 'shift'. Must be a valid JSON array.")
    }
    return parsedShift;
};

const generateDoctorUsername = async (email) => {
    const base = email
        .split("@")[0]
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "")
        .slice(0, 24) || "doctor";

    let candidate = base;
    let suffix = 1;
    while (await Doctor.exists({ doctorusername: candidate })) {
        candidate = `${base}${suffix}`;
        suffix += 1;
    }
    return candidate;
};

const uploadOptionalDoctorFiles = async (files = {}) => {
    const citizenshipDocumentBuffer = files?.citizenshipdocument?.[0]?.buffer;
    const medicalDegreeBuffer = files?.medicaldegree?.[0]?.buffer;
    const medicalLicenseBuffer = files?.medicallicense?.[0]?.buffer;
    const profilePictureBuffer = files?.profilepicture?.[0]?.buffer;

    const [citizenshipdocument, medicaldegree, medicallicense, profilepicture] = await Promise.all([
        citizenshipDocumentBuffer ? uploadLocal(citizenshipDocumentBuffer, "doctors/citizenship-document") : null,
        medicalDegreeBuffer ? uploadLocal(medicalDegreeBuffer, "doctors/medical-degree") : null,
        medicalLicenseBuffer ? uploadLocal(medicalLicenseBuffer, "doctors/medical-license") : null,
        profilePictureBuffer ? uploadLocal(profilePictureBuffer, "doctors/profile-picture") : null,
    ]);

    return {
        citizenshipdocument: citizenshipdocument?.secure_url || "",
        medicaldegree: medicaldegree?.secure_url || "",
        medicallicense: medicallicense?.secure_url || "",
        profilepicture: profilepicture?.secure_url || "",
    };
};

const createDoctorByAdmin = asyncHandler(async (req, res) => {
    const {
        doctorname,
        email,
        password,
        phonenumber,
        sex,
        age,
        experience,
        qualification,
        consultationfee,
        department,
        specialization,
        shift,
    } = req.body;

    if ([doctorname, email, password, consultationfee].some((field) => field === undefined || String(field).trim() === "")) {
        throw new apiError(400, "Doctor name, email, password, and consultation fee are required");
    }

    if (password.length < 8) {
        throw new apiError(400, "Password must be at least 8 characters");
    }

    const parsedFee = Number(consultationfee);
    if (Number.isNaN(parsedFee) || parsedFee < 0) {
        throw new apiError(400, "Consultation fee must be a valid positive number");
    }

    if (phonenumber && !/^[0-9]{10}$/.test(phonenumber)) {
        throw new apiError(400, "Phone number must be 10 digits");
    }
    const parsedAge = age !== undefined && age !== "" ? Number(age) : 0;
    if (Number.isNaN(parsedAge) || parsedAge < 0) {
        throw new apiError(400, "Age must be a valid positive number");
    }
    const parsedExperience = experience !== undefined && experience !== "" ? Number(experience) : 0;
    if (Number.isNaN(parsedExperience) || parsedExperience < 0) {
        throw new apiError(400, "Experience must be a valid positive number");
    }

    const existeddoctor = await Doctor.findOne({ email: email.trim().toLowerCase() });
    if (existeddoctor) {
        throw new apiError(409, "Doctor with same email already exists");
    }

    const doctorusername = await generateDoctorUsername(email);
    const verificationdocument = await uploadOptionalDoctorFiles(req.files);
    const shiftarray = parseShiftArray(shift);

    const doctor = await Doctor.create({
        doctorname: doctorname.trim(),
        doctorusername,
        email: email.trim().toLowerCase(),
        password,
        phonenumber: phonenumber?.trim() || "",
        sex: sex === "Other" ? "Others" : sex || "",
        age: parsedAge,
        verificationdocument,
        experience: parsedExperience,
        qualification: qualification?.trim() || "",
        consultationfee: parsedFee,
        department: department?.trim().toLowerCase() || "",
        specialization: specialization?.trim() || "",
        shift: shiftarray,
    });

    const createddoctor = await Doctor.findById(doctor._id).select("-password -refreshtoken");
    if (!createddoctor) {
        throw new apiError(500, "Doctor creation failed");
    }

    sendDoctorMail({
        to: createddoctor.email,
        subject: "Your SmartFit doctor account credentials",
        html: `
            <p>Hello ${createddoctor.doctorname},</p>
            <p>Your SmartFit doctor account has been created by the hospital administrator.</p>
            <p><strong>Email:</strong> ${createddoctor.email}</p>
            <p><strong>Password:</strong> ${password}</p>
            <p>Please log in and complete your doctor profile.</p>
        `,
    });

    return res
        .status(201)
        .json(new apiResponse(201, createddoctor, "Doctor created successfully"));
});

const deleteDoctorByAdmin = asyncHandler(async (req, res) => {
    const { doctorid } = req.params;
    const deletedDoctor = await Doctor.findByIdAndDelete(doctorid).select("-password -refreshtoken");

    if (!deletedDoctor) {
        throw new apiError(404, "Doctor not found");
    }

    return res
        .status(200)
        .json(new apiResponse(200, deletedDoctor, "Doctor deleted successfully"));
});

const updateDoctorByAdmin = asyncHandler(async (req, res) => {
    const { doctorid } = req.params;
    const {
        doctorname,
        email,
        password,
        phonenumber,
        sex,
        age,
        experience,
        qualification,
        consultationfee,
        department,
        specialization,
        shift,
    } = req.body;

    const doctor = await Doctor.findById(doctorid).select("+password");
    if (!doctor) {
        throw new apiError(404, "Doctor not found");
    }

    if (email && email.trim().toLowerCase() !== doctor.email) {
        const existingDoctor = await Doctor.findOne({
            email: email.trim().toLowerCase(),
            _id: { $ne: doctorid },
        });
        if (existingDoctor) {
            throw new apiError(409, "Doctor with same email already exists");
        }
        doctor.email = email.trim().toLowerCase();
    }

    if (doctorname !== undefined && doctorname.trim() !== "") {
        doctor.doctorname = doctorname.trim();
    }

    if (password !== undefined && password !== "") {
        if (password.length < 8) {
            throw new apiError(400, "Password must be at least 8 characters");
        }
        doctor.password = password;
    }

    if (phonenumber !== undefined) {
        if (phonenumber && !/^[0-9]{10}$/.test(phonenumber)) {
            throw new apiError(400, "Phone number must be 10 digits");
        }
        doctor.phonenumber = phonenumber?.trim() || "";
    }

    if (sex !== undefined) doctor.sex = sex === "Other" ? "Others" : sex || "";

    if (age !== undefined && age !== "") {
        const parsedAge = Number(age);
        if (Number.isNaN(parsedAge) || parsedAge < 0) {
            throw new apiError(400, "Age must be a valid positive number");
        }
        doctor.age = parsedAge;
    }

    if (experience !== undefined && experience !== "") {
        const parsedExperience = Number(experience);
        if (Number.isNaN(parsedExperience) || parsedExperience < 0) {
            throw new apiError(400, "Experience must be a valid positive number");
        }
        doctor.experience = parsedExperience;
    }

    if (consultationfee !== undefined && consultationfee !== "") {
        const parsedFee = Number(consultationfee);
        if (Number.isNaN(parsedFee) || parsedFee < 0) {
            throw new apiError(400, "Consultation fee must be a valid positive number");
        }
        doctor.consultationfee = parsedFee;
    }

    if (qualification !== undefined) doctor.qualification = qualification?.trim() || "";
    if (department !== undefined) doctor.department = department?.trim().toLowerCase() || "";
    if (specialization !== undefined) doctor.specialization = specialization?.trim() || "";
    if (shift !== undefined) doctor.shift = parseShiftArray(shift);

    const uploadedDocs = await uploadOptionalDoctorFiles(req.files);
    Object.entries(uploadedDocs).forEach(([key, value]) => {
        if (value) doctor.verificationdocument[key] = value;
    });

    await doctor.save();

    const updatedDoctor = await Doctor.findById(doctor._id).select("-password -refreshtoken");
    return res
        .status(200)
        .json(new apiResponse(200, updatedDoctor, "Doctor updated successfully"));
});

const registerdoctor = asyncHandler(async (req, res) => {
    const { doctorname, doctorusername, email, password, phonenumber, sex, age, experience, qualification, department, specialization, shift } = req.body;

    if ([doctorname, doctorusername, email, password, phonenumber, sex, age, experience, qualification, department, specialization, shift].some((field) => !field || field?.trim() === "")) {
        throw new apiError(400, "All fields are required");
    }
    const existeddoctor = await Doctor.findOne({
        $or: [{ doctorusername }, { email }]
    }
    )
    if (existeddoctor) {
        throw new apiError(409, "Doctor with same email or username already exists");
    }

    const citizenshipDocumentBuffer = req.files?.citizenshipdocument?.[0]?.buffer;
    const medicalDegreeBuffer = req.files?.medicaldegree?.[0]?.buffer;
    const medicalLicenseBuffer = req.files?.medicallicense?.[0]?.buffer;
    const profilePictureBuffer = req.files?.profilepicture?.[0]?.buffer;

    
    if (
        !citizenshipDocumentBuffer ||
        !medicalDegreeBuffer ||
        !medicalLicenseBuffer ||
        !profilePictureBuffer
    ) {
        throw new apiError(400, "All files are required");
    }

    
    const citizenshipdocument = await uploadLocal(citizenshipDocumentBuffer, "doctors/citizenship-document");
    const medicaldegree = await uploadLocal(medicalDegreeBuffer, "doctors/medical-degree");
    const medicallicense = await uploadLocal(medicalLicenseBuffer, "doctors/medical-license");
    const profilepicture = await uploadLocal(profilePictureBuffer, "doctors/profile-picture");

    
    if (
        !citizenshipdocument ||
        !medicaldegree ||
        !medicallicense ||
        !profilepicture
    ) {
        throw new apiError(500, "File upload failed");
    }

    const shiftarray = parseShiftArray(shift)
    const doctor = await Doctor.create({
        doctorname,
        doctorusername,
        email,
        password,
        phonenumber,
        sex,
        age,
        verificationdocument: {
            citizenshipdocument: citizenshipdocument.secure_url,
            medicaldegree: medicaldegree.secure_url,
            medicallicense: medicallicense.secure_url,
            profilepicture: profilepicture.secure_url,
        },
        experience,
        qualification,
        department: department.toLowerCase(),
        specialization,
        shift: shiftarray
    });
    if (!doctor) {
        throw new apiError(500, "Doctor registration failed");
    }
    const createddoctor = await Doctor.findById(doctor._id).select("-password -refreshtoken");
    if (!createddoctor) {
        throw new apiError(500, "Doctor not found");
    }
    sendDoctorMail({
        to: email,
        subject: `Welcome to SmartFit, ${createddoctor.doctorname}! Your Registration is Successful`,
        html: welcomeemailtemplate(createddoctor.doctorname),
    });

    return res.status(201).json(
        new apiResponse(201, createddoctor, "Doctor registered successfully")
    );

})

const logindoctor = asyncHandler(async (req, res) => {
    const { email, doctorusername, password } = req.body;
    if (!email && !doctorusername) {
        throw new apiError(400, "Email or username is required");
    }
    if (!password) {
        throw new apiError(400, "Password is required");
    }
    const existeddoctor = await Doctor.findOne({
        $or: [{ email }, { doctorusername }]
    }).select("+password")
    if (!existeddoctor) {
        throw new apiError(404, "Doctor not found");
    }
    const ispasswordvalid = await existeddoctor.ispasswordcorrect(password);
    if (!ispasswordvalid) {
        throw new apiError(401, "Invalid password");
    }
    const { accesstoken, refreshtoken } = await generateaccesstokenandrefreshtoken(existeddoctor._id);
    const loggedindoctor = await Doctor.findById(existeddoctor._id).select("-password -refreshtoken");
    if (!loggedindoctor) {
        throw new apiError(404, "Doctor login failed");
    }

    sendDoctorMail({
        to: email,
        subject: `Login Alert – SmartFit Account Accessed Successfully`,
        html: logintemplate(loggedindoctor.doctorname),
    });
    const options1 = {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "None" : "Lax",
        path: "/",
        maxAge: 1 * 24 * 60 * 60 * 1000
    };
    const options2 = {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "None" : "Lax",
        path: "/",
        maxAge: 20 * 24 * 60 * 60 * 1000
    }
    return res
        .status(200)
        .cookie("accesstoken", accesstoken, options1)
        .cookie("refreshtoken", refreshtoken, options2)
        .json(
            new apiResponse(
                200,
                {
                    user: loggedindoctor,
                    accesstoken,
                    refreshtoken
                },
                "Doctor logged in successfully"
            )
        );

});

const logoutdoctor = asyncHandler(async (req, res) => {
    await Doctor.findByIdAndUpdate(
        req.doctor?._id,
        {
            $unset: {
                refreshtoken: 1
            }
        },
        { new: true }
    );
    const options = {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "None" : "Lax",
        path: "/"
    };
    return res
        .clearCookie("accesstoken", options)
        .clearCookie("refreshtoken", options)
        .json(new apiResponse(200, {}, "Doctor logged out successfully"));
})

const accesstokenrenewal = asyncHandler(async (req, res) => {
    const { refreshtoken } = req.cookies || req.body;

    if (!refreshtoken) {
        throw new apiError(401, "Unauthorized request");
    }
    const decodetoken = jwt.verify(refreshtoken, process.env.REFRESH_TOKEN_SECRET);
    if (!decodetoken) {
        throw new apiError(401, "invalid refresh token");
    }
    if (decodetoken.role !== "doctor") {
        throw new apiError(401, "Doctor session required");
    }
    const doctor = await Doctor.findById(decodetoken._id);
    if (!doctor) {
        throw new apiError(404, "Doctor not found");
    }
    if (doctor.refreshtoken !== refreshtoken) {
        throw new apiError(401, "Invalid refresh token or token is expired");
    }
    const { accesstoken, refreshtoken: newrefreshtoken } = await generateaccesstokenandrefreshtoken(doctor._id);


    const options1 = {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "None" : "Lax",
        path: "/",
        maxAge: 1 * 24 * 60 * 60 * 1000
    }
    const options2 = {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "None" : "Lax",
        path: "/",
        maxAge: 20 * 24 * 60 * 60 * 1000
    }
    return res
        .status(200)
        .cookie("accesstoken", accesstoken, options1)
        .cookie("refreshtoken", newrefreshtoken, options2)
        .json(new apiResponse(200, { accesstoken, refreshtoken: newrefreshtoken }, "Access token renewed successfully"));

})

const updatepassword = asyncHandler(async (req, res) => {
    const { oldpassword, newpassword } = req.body;

    if (!oldpassword || !newpassword) {
        throw new apiError(400, "Old password and new password are required");
    }
    if (oldpassword === newpassword) {
        throw new apiError(400, "New password cannot be the same as old password");
    }
    const doctor = await Doctor.findById(req.doctor?._id).select("+password");
    if (!doctor) throw new apiError(404, "Doctor not found");
    const ispasswordvalid = await doctor.ispasswordcorrect(oldpassword);
    if (!ispasswordvalid) {
        throw new apiError(401, "Old password is incorrect");
    }
    doctor.password = newpassword;
    await doctor.save({ validateBeforeSave: false });

    return res.status(200).json(new apiResponse(200, {}, "Password updated successfully"));
})

const resetForgottenPassword = asyncHandler(async (req, res) => {
    const { newpassword } = req.body;
    if (!newpassword) throw new apiError(400, "New password is required");

    const doctor = await Doctor.findById(req.user?._id);
    if (!doctor) throw new apiError(404, "Doctor not found");

    doctor.password = newpassword;
    await doctor.save({ validateBeforeSave: false });

    return res.status(200).json(new apiResponse(200, {}, "Password reset successfully"));
});


const getdoctorprofiledetails = asyncHandler(async (req, res) => {
    const { doctorid } = req.params
    const doctor = await Doctor.findById(doctorid).select('-password -refreshtoken -verificationdocument.citizenshipdocument -verificationdocument.medicaldegree -verificationdocument.medicallicense')
    if (!doctor) {
        throw new apiError(404, "Doctor not found")
    }
    return res.status(200)
        .json(new apiResponse(200, doctor, "profile fetched successfully"))
})
const getdoctorprofiledetailsprivate = asyncHandler(async (req, res) => {
    const doctor = await Doctor.findById(req.doctor?._id).select("-password -refreshtoken")
    if (!doctor) {
        throw new apiError(404, "Doctor not found")
    }
    return res.status(200)
        .json(new apiResponse(200, doctor, "profile fetched successfully"))
})
const updateprofile = asyncHandler(async (req, res) => {
    const { phonenumber, age, sex, experience, qualification, department, specialization, shift } = req.body;

    if (!phonenumber || !age || !sex || experience === undefined || experience === "" || !qualification || !department || shift === undefined) {
        throw new apiError(400, "Phone number, age, gender, experience, qualification, department, and schedule are required");
    }

    const updates = {};
    if (!/^[0-9]{10}$/.test(phonenumber)) {
        throw new apiError(400, "Phone number must be 10 digits");
    }
    updates.phonenumber = phonenumber;
    if (age !== undefined && age !== "") {
        const parsedAge = Number(age);
        if (Number.isNaN(parsedAge) || parsedAge < 0) {
            throw new apiError(400, "Age must be a valid positive number");
        }
        updates.age = parsedAge;
    }
    updates.sex = sex === "Other" ? "Others" : sex;
    if (experience !== undefined && experience !== "") {
        const parsedExperience = Number(experience);
        if (Number.isNaN(parsedExperience) || parsedExperience < 0) {
            throw new apiError(400, "Experience must be a valid positive number");
        }
        updates.experience = parsedExperience;
    }
    updates.qualification = qualification
    updates.specialization = specialization || ""
    updates.department = department.toLowerCase()
    const parsedShift = parseShiftArray(shift);
    if (parsedShift.length === 0) {
        throw new apiError(400, "At least one availability schedule is required");
    }
    updates.shift = parsedShift;

    if (Object.keys(updates).length === 0) {
        throw new apiError(400, "At least one field is required to update");
    }

    const updateddoctor = await Doctor.findByIdAndUpdate(
        req.doctor?._id,
        { $set: updates },
        { new: true }
    ).select("-password -refreshtoken");

    if (!updateddoctor) {
        throw new apiError(404, "Doctor not found");
    }

    return res
        .status(200)
        .json(new apiResponse(200, updateddoctor, "Profile updated successfully"));
});

const getalldoctorprofiledetails = asyncHandler(async (req, res) => {
    const search = req.query.search?.trim() || "";

    const query = search
        ? { doctorname: { $regex: search, $options: "i" } }
        : {};

    const doctors = await Doctor.find(query).select(
        "doctorname specialization department qualification experience consultationfee shift verificationdocument.profilepicture"
    );

    return res
        .status(200)
        .json(new apiResponse(200, doctors, "Doctor profiles fetched successfully"));
});

const updateprofilepic = asyncHandler(async (req, res) => {
    const profilepicturelocalpath = req.file?.buffer;
    if (!profilepicturelocalpath) {
        throw new apiError(400, "profilepicture not found ")
    }
    const profilepicture = await uploadLocal(profilepicturelocalpath,"doctors/profile-picture")
    if (!profilepicture) {
        throw new apiError(400, "profilepicture upload failed to server")
    }
    const updateddoctor = await Doctor.findByIdAndUpdate(
        req.doctor?._id,
        {
            $set: {
                "verificationdocument.profilepicture": profilepicture.secure_url
            }
        },
        {
            new: true
        }).select("-password -refreshtoken")
    if (!updateddoctor) {
        throw new apiError(404, "doctor not found")
    }

    res.status(200)
        .json(new apiResponse(200, updateddoctor, "profilepicture updated successfully"))
})

const updatedocument = asyncHandler(async (req, res) => {
    const citizenshipdocumentlocalpath = req.files?.citizenshipdocument?.[0]?.buffer;
    const medicaldegreelocalpath = req.files?.medicaldegree?.[0]?.buffer;
    const medicallicenselocalpath = req.files?.medicallicense?.[0]?.buffer;
    if (!citizenshipdocumentlocalpath && !medicaldegreelocalpath && !medicallicenselocalpath) {
        throw new apiError(400, "Atleast one Document is required .")
    }
    let citizenshipdocument, medicaldegree, medicallicense

    if (citizenshipdocumentlocalpath) {
        citizenshipdocument = await uploadLocal(citizenshipdocumentlocalpath,"doctors/citizenship-document")
    }
    if (medicaldegreelocalpath) {
        medicaldegree = await uploadLocal(medicaldegreelocalpath,"doctors/medical-degree")
    }
    if (medicallicenselocalpath) {
        medicallicense = await uploadLocal(medicallicenselocalpath,"doctors/medical-license")
    }
    if (!citizenshipdocument && !medicaldegree && !medicallicense) {
        throw new apiError(400, "Error while uploading new files ")
    }
    const updateddoctor = await Doctor.findByIdAndUpdate(
        req.doctor?._id,
        {
            $set: {
                ...(citizenshipdocument ? { "verificationdocument.citizenshipdocument": citizenshipdocument.secure_url } : {}),
                ...(medicaldegree ? { "verificationdocument.medicaldegree": medicaldegree.secure_url } : {}),
                ...(medicallicense ? { "verificationdocument.medicallicense": medicallicense.secure_url } : {})
            }
        },
        {
            new: true
        }
    ).select("-password -refreshtoken")

    return res.status(200)
        .json(new apiResponse(200, updateddoctor, "Document updated successfully"))
})

const getdoctorbydept = asyncHandler(async (req, res) => {
    const { deptname } = req.params;
    const doctors = await Doctor.find({ department: deptname, }).select('doctorname specialization department qualification experience consultationfee shift verificationdocument.profilepicture');
    if (!doctors) {
        throw new apiError(404, "No doctors found for the given department")
    }
    return res.status(200)
        .json(new apiResponse(200, doctors, "Doctors fetched successfully"))
})
const getCurrentDoctor = asyncHandler(async (req, res) => {
    const doctor = await Doctor.findById(req.doctor?._id).select("-password -refreshtoken");
    if (!doctor) {
        throw new apiError(404, "Doctor not found");
    }
    return res.status(200).json(new apiResponse(200, doctor, "Current doctor fetched successfully"));
});
export { registerdoctor, logindoctor, logoutdoctor, accesstokenrenewal, updatepassword, resetForgottenPassword, getdoctorprofiledetails, updateprofile, updateprofilepic, updatedocument, getalldoctorprofiledetails, getdoctorprofiledetailsprivate, getdoctorbydept, getCurrentDoctor, createDoctorByAdmin, deleteDoctorByAdmin, updateDoctorByAdmin }; 
